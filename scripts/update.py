#!/usr/bin/env python3
"""
Netflix PL - aktualizacja listy tytułów.

Co robi ten skrypt (uruchamiany automatycznie przez GitHub Actions):
  1. Pobiera z TMDB listę filmów i seriali dostępnych w abonamencie Netflix w Polsce
     (dane o dostępności pochodzą od JustWatch).
  2. Dopisuje oceny IMDb z oficjalnego, codziennie odświeżanego zbioru IMDb.
  3. Dopisuje oceny Filmweb z nieoficjalnego API Filmweb (jeśli działa).
  4. Zaznacza tytuły nowe i usunięte z Netflix, zapisuje wszystko do docs/data.json.

Używa wyłącznie standardowej biblioteki Pythona - nie trzeba nic instalować.
"""
import datetime as dt
import gzip
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(ROOT, "docs", "data.json")
TODAY = dt.date.today().isoformat()

TMDB_KEY = os.environ.get("TMDB_API_KEY", "").strip()
FW_BUDGET = int(os.environ.get("FW_BUDGET", "8000"))      # max zapytań do Filmweb na jedno uruchomienie
FW_DELAY = float(os.environ.get("FW_DELAY", "0.3"))       # przerwa między zapytaniami do Filmweb [s]
FW_REFRESH_DAYS = 14     # co ile dni odświeżać ocenę Filmweb
FW_RETRY_DAYS = 30       # po ilu dniach ponowić szukanie tytułu nieznalezionego w Filmweb
IMDB_RETRY_DAYS = 14     # po ilu dniach ponowić szukanie brakującego ID IMDb
REMOVED_KEEP_DAYS = 60   # jak długo pamiętać tytuły usunięte z Netflix

UA_BOT = "NetflixPL-personal-list/1.0 (+github actions)"
UA_BROWSER = ("Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")


def log(*args):
    print(*args, flush=True)


def days_since(iso_date):
    if not iso_date:
        return 10 ** 6
    try:
        return (dt.date.today() - dt.date.fromisoformat(iso_date[:10])).days
    except ValueError:
        return 10 ** 6


def norm(text):
    """Uproszczony tytuł do porównań: małe litery, bez polskich znaków i interpunkcji."""
    text = unicodedata.normalize("NFKD", str(text or "").lower().replace("ł", "l"))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", text)


def http_get(url, headers=None, tries=4, timeout=30, raw=False):
    h = {"User-Agent": UA_BOT, "Accept": "application/json"}
    h.update(headers or {})
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
            return body if raw else json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep((attempt + 1) * (5 if e.code == 429 else 2))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < tries - 1:
                time.sleep((attempt + 1) * 2)
                continue
            raise


# --------------------------------------------------------------------------- TMDB
def tmdb(path, **params):
    headers = {}
    if TMDB_KEY.startswith("eyJ"):            # "API Read Access Token" (długi)
        headers["Authorization"] = "Bearer " + TMDB_KEY
    else:                                     # "API Key" (krótki)
        params["api_key"] = TMDB_KEY
    url = "https://api.themoviedb.org/3" + path + "?" + urllib.parse.urlencode(params)
    return http_get(url, headers)


def netflix_provider_ids():
    ids = set()
    for kind in ("movie", "tv"):
        data = tmdb(f"/watch/providers/{kind}", watch_region="PL", language="pl-PL") or {}
        for p in data.get("results", []):
            if str(p.get("provider_name", "")).strip().lower() == "netflix":
                ids.add(int(p["provider_id"]))
    return ids or {8}


def genre_map(kind):
    data = tmdb(f"/genre/{kind}/list", language="pl-PL") or {}
    return {g["id"]: g["name"][:1].upper() + g["name"][1:] for g in data.get("genres", [])}


def discover(kind, providers):
    """Zwraca wszystkie wyniki TMDB 'discover' dla Netflix PL (dzieli zakres lat, gdy > 500 stron)."""
    date_field = "primary_release_date" if kind == "movie" else "first_air_date"
    base = dict(watch_region="PL",
                with_watch_providers="|".join(str(p) for p in sorted(providers)),
                with_watch_monetization_types="flatrate",
                language="pl-PL", include_adult="false", sort_by="popularity.desc")
    results = {}

    def fetch_page(extra, page):
        try:
            return tmdb(f"/discover/{kind}", **base, **extra, page=page) or {}
        except Exception as e:  # pojedyncza strona - spróbuj jeszcze raz później
            log(f"  ! błąd strony {page}: {e}")
            time.sleep(3)
            return tmdb(f"/discover/{kind}", **base, **extra, page=page) or {}

    def collect(lo=None, hi=None):
        extra = {}
        if lo is not None:
            extra = {f"{date_field}.gte": f"{lo}-01-01", f"{date_field}.lte": f"{hi}-12-31"}
        first = fetch_page(extra, 1)
        pages = int(first.get("total_pages") or 0)
        if pages > 500:
            if lo is None:
                y = dt.date.today().year + 2
                collect(1870, 1999)
                collect(2000, y)
                return
            if hi > lo:
                mid = (lo + hi) // 2
                collect(lo, mid)
                collect(mid + 1, hi)
                return
        for r in first.get("results", []):
            results[r["id"]] = r
        if pages > 1:
            with ThreadPoolExecutor(6) as ex:
                for d in ex.map(lambda p: fetch_page(extra, p), range(2, min(pages, 500) + 1)):
                    for r in d.get("results", []):
                        results[r["id"]] = r

    collect()
    return list(results.values())


def build_item(kind, r, gmap):
    k = "m" if kind == "movie" else "s"
    date = (r.get("release_date") if kind == "movie" else r.get("first_air_date")) or ""
    return {
        "id": f"{k}{r['id']}",
        "k": k,
        "t": (r.get("title") or r.get("name") or "").strip(),
        "o": (r.get("original_title") or r.get("original_name") or "").strip(),
        "y": int(date[:4]) if date[:4].isdigit() else None,
        "g": [gmap[g] for g in r.get("genre_ids", []) if g in gmap],
        "p": r.get("poster_path") or "",
        "d": (r.get("overview") or "").strip(),
        "pop": round(float(r.get("popularity") or 0), 1),
    }


def add_imdb_ids(items):
    need = [it for it in items if "imdb" not in it
            or (not it["imdb"] and days_since(it.get("ic")) >= IMDB_RETRY_DAYS)]
    log(f"IMDb ID: do sprawdzenia {len(need)} tytułów")

    def one(it):
        kind = "movie" if it["k"] == "m" else "tv"
        try:
            d = tmdb(f"/{kind}/{it['id'][1:]}/external_ids") or {}
            return it, (d.get("imdb_id") or ""), True
        except Exception:
            return it, "", False

    with ThreadPoolExecutor(8) as ex:
        for it, imdb_id, ok in ex.map(one, need):
            if ok:
                it["imdb"] = imdb_id
                it["ic"] = TODAY


def add_imdb_ratings(items):
    wanted = {it["imdb"] for it in items if it.get("imdb")}
    log(f"IMDb: pobieram oficjalny zbiór ocen (dla {len(wanted)} tytułów)")
    raw = http_get("https://datasets.imdbws.com/title.ratings.tsv.gz",
                   headers={"Accept": "*/*"}, raw=True, timeout=180)
    ratings = {}
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as f:
        for line in io.TextIOWrapper(f, encoding="utf-8"):
            tconst, _, rest = line.partition("\t")
            if tconst in wanted:
                rate, votes = rest.strip().split("\t")
                ratings[tconst] = (float(rate), int(votes))
    for it in items:
        r = ratings.get(it.get("imdb"))
        if r:
            it["ir"], it["iv"] = r
        else:
            it.pop("ir", None)
            it.pop("iv", None)
    log(f"IMDb: ocena dla {sum(1 for it in items if 'ir' in it)} tytułów")


# ------------------------------------------------------------------------ Filmweb
class StopFilmweb(Exception):
    pass


class Filmweb:
    """Nieoficjalne API Filmweb (to samo, którego używa strona). Może przestać działać bez ostrzeżenia."""
    BASE = "https://www.filmweb.pl/api/v1"
    HEADERS = {"User-Agent": UA_BROWSER, "x-locale": "pl_PL", "Accept": "application/json",
               "Origin": "https://www.filmweb.pl", "Referer": "https://www.filmweb.pl/"}
    SEARCH_PATHS = ("/live/search?query=", "/search?query=")

    def __init__(self, budget):
        self.budget = budget
        self.fails = 0
        self.dead = False
        self.ok_calls = 0
        self.search_path = None

    def get(self, path):
        if self.dead or self.budget <= 0:
            raise StopFilmweb()
        self.budget -= 1
        time.sleep(FW_DELAY)
        try:
            data = http_get(self.BASE + path, self.HEADERS, tries=2, timeout=20)
            self.fails = 0
            self.ok_calls += 1
            return data
        except Exception as e:
            self.fails += 1
            if self.fails >= 15:
                self.dead = True
                log(f"Filmweb: zbyt wiele błędów z rzędu ({e}) - pomijam Filmweb w tym uruchomieniu")
            return None

    @staticmethod
    def _hits(data):
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("searchHits", "hits", "results", "items"):
                if isinstance(data.get(key), list):
                    return data[key]
        return []

    def search(self, query):
        q = urllib.parse.quote(query)
        paths = [self.search_path] if self.search_path else self.SEARCH_PATHS
        for p in paths:
            hits = self._hits(self.get(p + q))
            if hits:
                self.search_path = p
                return hits
        return []

    def match(self, it):
        want = "film" if it["k"] == "m" else "serial"
        queries = [it["t"]]
        if it["o"] and norm(it["o"]) != norm(it["t"]):
            queries.append(it["o"])
        targets = {norm(it["t"]), norm(it["o"])} - {""}
        for q in queries:
            if not q:
                continue
            hits = [h for h in self.search(q)
                    if str(h.get("type", "")).lower() == want and h.get("id")][:4]
            for h in hits:
                info = self.get(f"/title/{h['id']}/info") or {}
                names = {norm(info.get("title")), norm(info.get("originalTitle")),
                         norm(h.get("matchedTitle"))}
                year = info.get("year")
                year_ok = it["y"] is None or not year or abs(int(year) - it["y"]) <= 1
                if year_ok and targets & names:
                    title = info.get("title") or h.get("matchedTitle") or it["t"]
                    slug = urllib.parse.quote(re.sub(r"\s+", "+", title.strip()), safe="+")
                    url = f"{want}/{slug}-{year or it['y'] or 0}-{h['id']}"
                    return int(h["id"]), url
        return None, None

    def rating(self, fw_id):
        d = self.get(f"/film/{fw_id}/rating")
        if not isinstance(d, dict):
            return None, None
        rate = d.get("rate", d.get("rating"))
        count = d.get("count", d.get("votes"))
        try:
            return (round(float(rate), 1) if rate else None), (int(count) if count else None)
        except (TypeError, ValueError):
            return None, None


def add_filmweb(items):
    fw = Filmweb(FW_BUDGET)
    to_match = [it for it in items if "fwc" not in it
                or (not it.get("fw") and days_since(it.get("fwc")) >= FW_RETRY_DAYS)]
    to_match.sort(key=lambda it: -it.get("pop", 0))
    to_refresh = [it for it in items if it.get("fw") and days_since(it.get("frd")) >= FW_REFRESH_DAYS]
    to_refresh.sort(key=lambda it: it.get("frd") or "")
    log(f"Filmweb: do dopasowania {len(to_match)}, do odświeżenia ocen {len(to_refresh)}")
    matched = refreshed = 0
    try:
        for it in to_match:
            fw_id, url = fw.match(it)
            if fw.dead:
                break
            it["fwc"] = TODAY
            if fw_id:
                it["fw"], it["fu"] = fw_id, url
                rate, count = fw.rating(fw_id)
                if rate:
                    it["fr"], it["fv"] = rate, count
                it["frd"] = TODAY
                matched += 1
        for it in to_refresh:
            rate, count = fw.rating(it["fw"])
            if fw.dead:
                break
            if rate:
                it["fr"], it["fv"] = rate, count
            it["frd"] = TODAY
            refreshed += 1
    except StopFilmweb:
        pass
    works = fw.ok_calls > 0 and not fw.dead
    log(f"Filmweb: dopasowano {matched}, odświeżono {refreshed}, API działa: {works}")
    return works


# --------------------------------------------------------------------------- main
def main():
    if not TMDB_KEY:
        sys.exit("BŁĄD: brak klucza TMDB. Dodaj sekret repozytorium o nazwie TMDB_API_KEY "
                 "(Settings > Secrets and variables > Actions).")

    old = {"meta": {}, "items": [], "removed": []}
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding="utf-8") as f:
            old = json.load(f)
    old_items = {it["id"]: it for it in old.get("items", [])}

    providers = netflix_provider_ids()
    log(f"Netflix - ID dostawcy w TMDB: {providers}")
    items = []
    for kind in ("movie", "tv"):
        gmap = genre_map(kind)
        rows = discover(kind, providers)
        log(f"TMDB: {'filmy' if kind == 'movie' else 'seriale'}: {len(rows)}")
        items += [build_item(kind, r, gmap) for r in rows]

    if len(old_items) > 200 and len(items) < 0.6 * len(old_items):
        sys.exit(f"BŁĄD: pobrano tylko {len(items)} tytułów (poprzednio {len(old_items)}). "
                 "Wygląda na chwilowy problem z TMDB - dane NIE zostały nadpisane.")

    keep = ("imdb", "ic", "ir", "iv", "fw", "fu", "fwc", "fr", "fv", "frd", "add")
    for it in items:
        prev = old_items.get(it["id"])
        if prev:
            for k in keep:
                if k in prev:
                    it[k] = prev[k]
        it.setdefault("add", TODAY)

    new_ids = {it["id"] for it in items}
    removed = [r for r in old.get("removed", [])
               if r["id"] not in new_ids and days_since(r.get("rm")) <= REMOVED_KEEP_DAYS]
    removed_today = [{"id": o["id"], "k": o["k"], "t": o["t"], "o": o.get("o", ""),
                      "y": o.get("y"), "fu": o.get("fu"), "imdb": o.get("imdb"), "rm": TODAY}
                     for oid, o in old_items.items() if oid not in new_ids]
    removed = removed_today + removed

    add_imdb_ids(items)
    add_imdb_ratings(items)
    fw_ok = add_filmweb(items)

    items.sort(key=lambda it: -it.get("pop", 0))
    meta = {
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "first": old.get("meta", {}).get("first") or TODAY,
        "count": len(items),
        "movies": sum(1 for it in items if it["k"] == "m"),
        "series": sum(1 for it in items if it["k"] == "s"),
        "added_today": sum(1 for it in items if it["add"] == TODAY and it["id"] not in old_items),
        "removed_today": len(removed_today),
        "fw_ok": fw_ok,
        "fw_count": sum(1 for it in items if it.get("fr")),
        "imdb_count": sum(1 for it in items if it.get("ir")),
    }
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "items": items, "removed": removed}, f,
                  ensure_ascii=False, separators=(",", ":"))
    log("GOTOWE:", json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
