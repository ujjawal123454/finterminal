import pandas as pd
import io
import time
from curl_cffi import requests as req_lib

class ChittorgarhScraper:
    def __init__(self):
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
        }
        self.nse_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.nseindia.com/reports/fii-dii",
        }

    def _get_tables(self, url, timeout=20):
        try:
            resp = req_lib.get(url, headers=self.headers, impersonate="chrome110", timeout=timeout)
            if resp.status_code != 200:
                print(f"[Scraper] Error {resp.status_code} for {url}")
                return []
            return pd.read_html(io.StringIO(resp.text))
        except Exception as e:
            print(f"[Scraper] Exception: {e}")
            return []

    def get_mainline_ipo(self):
        try:
            tabs = self._get_tables("https://www.moneycontrol.com/ipo/")
            for df in tabs:
                if "Company Name" in str(df.columns):
                    df = df.rename(columns={"Company Name": "Company", "Issue Price": "Price", "Listing Date": "Date"})
                    return df.fillna("—").to_dict(orient="records")
        except Exception as e:
            print(f"Mainline IPO Error: {e}")
        return []

    def get_sme_ipo(self):
        try:
            tabs = self._get_tables("https://www.moneycontrol.com/ipo/ipo-snapshot/listing.html?type=sme")
            for df in tabs:
                if "Company Name" in str(df.columns):
                    return df.fillna("—").to_dict(orient="records")
        except Exception as e:
            print(f"SME IPO Error: {e}")
        return []

    def get_gmp(self):
        """Fetch live GMP data from ipowatch.in"""
        try:
            resp = req_lib.get(
                "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/",
                impersonate="chrome", timeout=20
            )
            if resp.status_code != 200:
                print(f"[GMP] ipowatch status: {resp.status_code}")
                return []
            tabs = pd.read_html(io.StringIO(resp.text))
            if not tabs:
                return []

            # Table 0 = Live GMP, Table 1 = Past listings
            results = {"live": [], "past": []}

            # Parse live GMP (table 0)
            if len(tabs) > 0:
                df = tabs[0]
                # First row is header
                if len(df) > 1:
                    for _, row in df.iloc[1:].iterrows():
                        vals = [str(row.get(c, "")) for c in df.columns]
                        if len(vals) >= 6:
                            results["live"].append({
                                "name": vals[0],
                                "gmp": vals[1],
                                "trend": vals[2],
                                "price": vals[3],
                                "estListing": vals[4],
                                "date": vals[5] if len(vals) > 5 else "",
                                "type": vals[6] if len(vals) > 6 else "",
                                "status": vals[7] if len(vals) > 7 else "",
                                "updated": vals[8] if len(vals) > 8 else "",
                            })

            # Parse past listings (table 1)
            if len(tabs) > 1:
                df2 = tabs[1]
                if len(df2) > 1:
                    for _, row in df2.iloc[1:6].iterrows():  # Top 5
                        vals = [str(row.get(c, "")) for c in df2.columns]
                        if len(vals) >= 4:
                            results["past"].append({
                                "name": vals[0],
                                "price": vals[1],
                                "gmp": vals[2],
                                "listPrice": vals[3],
                            })

            return results
        except Exception as e:
            print(f"GMP Error: {e}")
        return {"live": [], "past": []}

    def get_bonds(self):
        try:
            tabs = self._get_tables("https://www.moneycontrol.com/ncd/issue-listing.html")
            if tabs:
                return tabs[0].fillna("—").to_dict(orient="records")
        except Exception as e:
            print(f"Bonds Error: {e}")
        return []

    def get_fii_dii(self):
        try:
            session = req_lib.Session(impersonate="chrome")
            session.headers.update(self.nse_headers)
            session.get("https://www.nseindia.com", timeout=15)
            time.sleep(0.5)
            resp = session.get("https://www.nseindia.com/api/fiidiiTradeReact", timeout=20)
            if resp.status_code == 200:
                return resp.json()
            print(f"FII/DII Status: {resp.status_code}")
        except Exception as e:
            print(f"FII/DII Error: {e}")
        return []
