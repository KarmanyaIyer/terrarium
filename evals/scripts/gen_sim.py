"""Generate the sim suites (tool-basics, shell-data) with seeded setup data.

Expected answers are computed here in Python. evals/scripts/verify.ts then runs an
independent shell reference solution (evals/reference/<suite>/<case>.sh) in just-bash
and checks that it reaches the same answer.

Run: python3 -I evals/scripts/gen_sim.py
"""

import csv
import io
import json
import os
import random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITES = os.path.join(ROOT, "suites")


def W(path, content):
    return {"path": "/workspace/" + path, "content": content}


def case(cid, title, prompt, files, check, max_turns=10, timeout=240):
    return {
        "id": cid,
        "title": title,
        "prompt": prompt,
        "envType": "sim",
        "setupFiles": files,
        "check": check,
        "maxTurns": max_turns,
        "timeoutSec": timeout,
    }


def number(v):
    return {"type": "answer", "mode": "number", "expected": str(v)}


def file_equals(path, content):
    return {"type": "file", "path": path, "equals": content}


def jq_equals(path, value):
    lit = json.dumps(value, separators=(",", ":"), sort_keys=True)
    # Keys are sorted on both sides: just-bash 3.6's jq compares objects key-order sensitively.
    return {"type": "command", "command": "jq -S . " + path + " | jq -e '. == " + lit + "' > /dev/null"}


# ---------------------------------------------------------------- tool-basics


def tb_find_port():
    files = [
        W("README.md", "# lark\n\nMonorepo for the Lark services. See docs/ for deployment notes.\n"),
        W("docs/deploy.md", "# Deploying\n\nThe api service listens on port 8000 by default unless its settings file says otherwise.\n"),
        W("services/web/config.example.ini", "[server]\nhost = 127.0.0.1\nport = 8080\n"),
        W("services/web/src/app.js", "const port = process.env.PORT || 3000;\nconsole.log(`web on ${port}`);\n"),
        W(
            "services/api/config/settings.ini",
            "; api settings\n[metrics]\nport = 9100\nenabled = true\n\n[server]\nhost = 0.0.0.0\nport = 8443\nworkers = 4\n\n[db]\nport = 5432\n",
        ),
        W("services/api/src/main.py", "import configparser\n\ncfg = configparser.ConfigParser()\ncfg.read('config/settings.ini')\n"),
    ]
    return case(
        "tb-find-port",
        "Find settings.ini, read port",
        "Somewhere under /workspace there is a file named settings.ini. Find it and reply with only the port number from its [server] section.",
        files,
        number(8443),
        max_turns=8,
    )


def tb_write_todo():
    return case(
        "tb-write-todo",
        "Write a 3-line file",
        "Create the file /workspace/notes/todo.txt (the notes directory does not exist yet) containing exactly these three lines in this order, and nothing else:\nbuy milk\ncall the plumber\nrenew passport",
        [W("README.md", "Scratch space.\n")],
        file_equals("/workspace/notes/todo.txt", "buy milk\ncall the plumber\nrenew passport\n"),
        max_turns=8,
    )


APP_CONF = """# Lark API server configuration
listen_address = 0.0.0.0
listen_port = 8443

# Connection limits
# max_connections = 50   (old default)
max_connections = 100
max_connections_per_ip = 100
idle_timeout = 30

# Logging
log_level = info
log_file = /var/log/lark/api.log
"""


def tb_edit_line():
    return case(
        "tb-edit-line",
        "Edit one config line",
        "In /workspace/app.conf, change the active max_connections setting from 100 to 250. Leave every other line exactly as it is, including the commented-out line and max_connections_per_ip.",
        [W("app.conf", APP_CONF)],
        file_equals("/workspace/app.conf", APP_CONF.replace("max_connections = 100\n", "max_connections = 250\n")),
        max_turns=8,
    )


def tb_count_errors(rng):
    workers = ["api", "db", "worker-1", "worker-2", "scheduler"]
    msgs = {
        "INFO": ["request served", "cache warmed", "retrying after error in upstream", "job finished", "user login ok"],
        "DEBUG": ["poll tick", "heartbeat sent", "error budget at 97%"],
        "WARN": ["slow query (812 ms)", "upstream returned ERROR 503, retrying", "disk 81% full"],
        "ERROR": ["payment provider timeout", "failed to write checkpoint", "unhandled exception in handler"],
    }
    levels = ["INFO"] * 10 + ["DEBUG"] * 4 + ["WARN"] * 3 + ["ERROR"] * 2
    lines = []
    count = 0
    for i in range(240):
        lvl = rng.choice(levels)
        count += lvl == "ERROR"
        ts = "2025-03-14T%02d:%02d:%02dZ" % (9 + i // 60, i % 60, rng.randrange(60))
        lines.append("%s %-5s [%s] %s" % (ts, lvl, rng.choice(workers), rng.choice(msgs[lvl])))
    return case(
        "tb-count-errors",
        "Count ERROR-level log lines",
        "How many lines in /workspace/logs/app.log have the log level ERROR? The level is the second field on each line; the word may also appear inside messages, which does not count. Reply with only the number.",
        [W("logs/app.log", "\n".join(lines) + "\n")],
        number(count),
    )


def tb_top_5xx_ip(rng):
    ips = ["10.0.4.%d" % n for n in (11, 12, 23, 37, 41, 58, 66)]
    paths = ["/", "/api/items", "/api/cart", "/login", "/static/app.js", "/api/checkout"]
    rows = []
    # 10.0.4.11 is the busiest client overall but not the top 5xx one.
    weights = [9, 3, 4, 2, 3, 2, 3]
    for i in range(300):
        ip = rng.choices(ips, weights)[0]
        status = rng.choices([200, 200, 200, 304, 404, 500, 502, 503], [30, 30, 30, 5, 6, 3, 2, 2])[0]
        if ip == "10.0.4.23" and rng.random() < 0.35:
            status = rng.choice([500, 502, 503])
        if ip == "10.0.4.11" and status >= 500 and rng.random() < 0.7:
            status = 200
        size = rng.randrange(200, 9000)
        rows.append((ip, status, '%s - - [14/Mar/2025:10:%02d:%02d +0000] "GET %s HTTP/1.1" %d %d' % (ip, i // 6 % 60, i % 60, rng.choice(paths), status, size)))
    totals = {}
    fives = {}
    for ip, st, _ in rows:
        totals[ip] = totals.get(ip, 0) + 1
        if st >= 500:
            fives[ip] = fives.get(ip, 0) + 1
    ranked = sorted(fives.items(), key=lambda kv: -kv[1])
    assert ranked[0][1] > ranked[1][1], ranked
    busiest = max(totals.items(), key=lambda kv: kv[1])[0]
    assert busiest != ranked[0][0], (busiest, ranked)
    return case(
        "tb-top-5xx-ip",
        "Busiest 5xx client IP",
        "/workspace/access.log is a web server access log. Which client IP address received the most responses with a 5xx status code (500-599)? Write only that IP address to /workspace/answer.txt.",
        [W("access.log", "\n".join(r[2] for r in rows) + "\n")],
        file_equals("/workspace/answer.txt", ranked[0][0] + "\n"),
    )


def tb_png_bytes(rng):
    names = [
        "assets/logo.png", "assets/logo@2x.png", "assets/icons/home.png", "assets/icons/search.png",
        "assets/icons/old/settings.png", "assets/hero.jpg", "assets/icons/menu.svg", "assets/logo.png.bak",
        "assets/fonts/inter.woff2", "assets/screens/a.png", "assets/screens/b.png", "assets/screens/notes.txt",
    ]
    files = []
    total = 0
    for n in names:
        size = rng.randrange(300, 4000)
        files.append(W(n, ("x" * 63 + "\n") * (size // 64) + "y" * (size % 64)))
        if n.endswith(".png"):
            total += size
    return case(
        "tb-png-bytes",
        "Total size of .png files",
        "What is the total size in bytes of all files whose names end in .png anywhere under /workspace/assets, including subdirectories? Reply with only the number.",
        files,
        number(total),
    )


def tb_shipped_orders(rng):
    customers = ["acme", "globex", "initech", "umbrella", "hooli", "stark"]
    orders = []
    n = 0
    for i in range(60):
        status = rng.choice(["shipped", "shipped", "pending", "cancelled", "delivered"])
        total = round(rng.uniform(20, 260), 2)
        if i in (7, 31):
            total = 100.0
            status = "shipped"
        items = [{"sku": "SKU-%03d" % rng.randrange(1000), "qty": rng.randrange(1, 4)} for _ in range(rng.randrange(1, 4))]
        orders.append({"id": 5000 + i, "customer": rng.choice(customers), "status": status, "total": total, "items": items})
        n += status == "shipped" and total > 100
    return case(
        "tb-shipped-orders",
        "Count orders with jq-style filter",
        "/workspace/data/orders.json holds a JSON array of orders. How many orders have status \"shipped\" and a total strictly greater than 100? Reply with only the number.",
        [W("data/orders.json", json.dumps(orders, indent=2) + "\n")],
        number(n),
    )


def tb_missing_report():
    files = [
        W("reports/2024/Q2_summary.txt", "Lark Inc. Q2 2024 summary\nTotal revenue: $1,190,410\nNew customers: 311\n"),
        W("reports/2024/Q3_summary.txt", "Lark Inc. Q3 2024 summary\nTotal revenue: $1,284,350\nNew customers: 287\nChurn: 2.1%\n"),
        W("reports/2023/Q3_summary.txt", "Lark Inc. Q3 2023 summary\nTotal revenue: $1,102,900\nNew customers: 240\n"),
        W("reports/README.md", "Quarterly summaries, one folder per year.\n"),
    ]
    return case(
        "tb-missing-report",
        "Recover from a wrong path",
        "Read the Q3 2024 summary at /workspace/reports/q3-summary.txt and reply with only the total revenue figure it reports, as a plain number with no currency sign and no commas.",
        files,
        number(1284350),
        max_turns=10,
    )


MEAN_PY = """import sys

vals = [float(line) for line in open(sys.argv[1]) if line.strip()]
print(f"{sum(vals) / len(vals):.2f}")
"""


def tb_fix_bad_reading(rng):
    vals = [round(rng.uniform(10, 30), 1) for _ in range(30)]
    lines = ["%.1f" % v for v in vals]
    lines.insert(11, "n/a")
    lines.insert(23, "--")
    mean = "%.2f" % (sum(vals) / len(vals))
    return case(
        "tb-fix-bad-reading",
        "Fix bad input, rerun script",
        "Run `python3 /workspace/tools/mean.py /workspace/data/readings.txt` and save its output (just the number it prints) to /workspace/mean.txt. If the command fails, find the cause and fix the data file by deleting the invalid line(s). Do not modify mean.py.",
        [W("tools/mean.py", MEAN_PY), W("data/readings.txt", "\n".join(lines) + "\n")],
        file_equals("/workspace/mean.txt", mean + "\n"),
        max_turns=12,
    )


def tb_jpg_manifest(rng):
    files = []
    big = []
    for i in range(1, 15):
        name = "IMG_%04d.jpg" % (i * 7)
        size = rng.choice([rng.randrange(300, 999), rng.randrange(1001, 4000)])
        if i == 5:
            size = 1000
        files.append(W("photos/" + name, "J" * size))
        if size > 1000:
            big.append(name)
    files.append(W("photos/cover.jpeg", "J" * 2500))
    files.append(W("photos/scan.png", "P" * 3000))
    files.append(W("photos/thumbs/IMG_0007_big.jpg", "J" * 1800))
    files.append(W("photos/thumbs/IMG_0014.jpg", "J" * 200))
    big.sort()
    return case(
        "tb-jpg-manifest",
        "List large .jpg files",
        "List the names (just the file names, not paths) of all .jpg files directly inside /workspace/photos, not in its subfolders, that are larger than 1000 bytes. Write them to /workspace/manifest.txt, one per line, sorted alphabetically.",
        files,
        file_equals("/workspace/manifest.txt", "\n".join(big) + "\n"),
    )


# ---------------------------------------------------------------- shell-data


def sales_csv(rng):
    regions = ["North", "South", "East", "West", "Northwest"]
    products = [("Widget", 4.25), ("Widget Pro", 11.5), ("Gadget", 7.8), ("Gizmo", 2.15)]
    rows = []
    for i in range(48):
        p, price = rng.choice(products)
        rows.append(["2025-%02d-%02d" % (1 + i // 16, 1 + i % 28), rng.choice(regions), p, rng.randrange(1, 60), price])
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["date", "region", "product", "units", "unit_price"])
    for r in rows:
        w.writerow(r[:4] + ["%.2f" % r[4]])
    return buf.getvalue(), rows


def sd_west_units(text, rows):
    return case(
        "sd-west-units",
        "Sum a CSV column by region",
        "/workspace/sales.csv has the columns date, region, product, units, unit_price. What is the total number of units sold in the region West (exactly West, not other regions)? Reply with only the number.",
        [W("sales.csv", text)],
        number(sum(r[3] for r in rows if r[1] == "West")),
    )


def sd_widget_revenue(text, rows):
    cents = sum(r[3] * round(r[4] * 100) for r in rows if r[2] == "Widget")
    return case(
        "sd-widget-revenue",
        "Revenue for one product",
        "/workspace/sales.csv has the columns date, region, product, units, unit_price. Compute the total revenue (units times unit_price, summed over rows) for the product Widget only (not Widget Pro), across all regions. Write it to /workspace/answer.txt with exactly two decimal places, for example 123.40, and nothing else.",
        [W("sales.csv", text)],
        file_equals("/workspace/answer.txt", "%d.%02d\n" % (cents // 100, cents % 100)),
    )


def sd_country_join(rng):
    people = [
        ("Smith, John", "US"), ("Okafor, Ada", "NG"), ("Lee, Min", "KR"), ("Garcia, Ana", "ES"),
        ("Brown, Sam", "US"), ("Kim, Joon", "KR"), ("Ruiz, Leo", "ES"), ("Nwosu, Ife", "NG"),
        ("Patel, Ravi", "IN"), ("Mehta, Isha", "IN"),
    ]
    cbuf = io.StringIO()
    cw = csv.writer(cbuf, lineterminator="\n")
    cw.writerow(["id", "name", "country"])
    for i, (name, c) in enumerate(people, start=101):
        cw.writerow([i, name, c])
    obuf = io.StringIO()
    ow = csv.writer(obuf, lineterminator="\n")
    ow.writerow(["order_id", "customer_id", "amount"])
    totals = {}
    for j in range(40):
        cid = rng.randrange(101, 111)
        amt = rng.randrange(500, 40000)
        ow.writerow([9000 + j, cid, "%d.%02d" % (amt // 100, amt % 100)])
        c = people[cid - 101][1]
        totals[c] = totals.get(c, 0) + amt
    ranked = sorted(totals.items(), key=lambda kv: -kv[1])
    assert len(set(v for _, v in ranked)) == len(ranked)
    out = "country,total\n" + "".join("%s,%d.%02d\n" % (c, v // 100, v % 100) for c, v in ranked)
    return case(
        "sd-country-join",
        "Join two CSVs, total by country",
        "/workspace/customers.csv (id, name, country) and /workspace/orders.csv (order_id, customer_id, amount) are CSV files; note that names contain commas and are quoted. Write /workspace/totals.csv with the header line country,total followed by one line per country giving the sum of order amounts for customers in that country, sorted by total from highest to lowest, with totals written with exactly two decimal places.",
        [W("customers.csv", cbuf.getvalue()), W("orders.csv", obuf.getvalue())],
        file_equals("/workspace/totals.csv", out),
        max_turns=12,
    )


def sd_event_counts(rng):
    types = ["click", "view", "scroll", "purchase", "signup"]
    events = []
    counts = {}
    for i in range(80):
        t = rng.choices(types, [30, 40, 15, 5, 3])[0]
        counts[t] = counts.get(t, 0) + 1
        events.append({"id": i + 1, "user": "u%02d" % rng.randrange(20), "type": t, "ts": 1741946400 + i * 37})
    return case(
        "sd-event-counts",
        "Group JSON events by type",
        "/workspace/events.json is a JSON array of events, each with a type field. Write /workspace/counts.json containing a single JSON object that maps each event type to the number of events of that type, for example {\"click\": 3, \"view\": 5}.",
        [W("events.json", json.dumps(events) + "\n")],
        jq_equals("/workspace/counts.json", counts),
    )


def sd_active_emails(rng):
    first = ["ada", "grace", "linus", "ken", "barbara", "dennis", "margaret", "alan", "edsger", "frances", "john", "radia"]
    users = []
    active = []
    for i, f in enumerate(first):
        domain = rng.choice(["Example.com", "example.org", "LARK.dev"])
        email = (f.capitalize() if rng.random() < 0.5 else f) + "@" + domain
        is_active = rng.random() < 0.6
        users.append({"id": i + 1, "active": is_active, "profile": {"name": f.capitalize(), "email": email}, "roles": rng.sample(["admin", "dev", "ops", "viewer"], 2)})
        if is_active:
            active.append(email.lower())
    active.sort()
    return case(
        "sd-active-emails",
        "Extract nested JSON fields",
        "/workspace/users.json has a top-level users array. Each user has an active flag and a profile.email field. Write /workspace/active_emails.json containing a JSON array of the email addresses of the active users only, converted to lowercase and sorted alphabetically.",
        [W("users.json", json.dumps({"users": users, "generated": "2025-03-14"}, indent=2) + "\n")],
        jq_equals("/workspace/active_emails.json", active),
    )


def sd_search_latency(rng):
    paths = ["/api/search", "/api/search", "/api/search/suggest", "/api/items", "/health"]
    lines = []
    picked = []
    for i in range(120):
        p = rng.choice(paths)
        method = "GET" if rng.random() < 0.85 else "POST"
        status = rng.choices([200, 400, 500], [85, 10, 5])[0]
        ms = rng.randrange(20, 900)
        lines.append(json.dumps({"ts": 1741946400 + i * 3, "method": method, "path": p, "status": status, "ms": ms}))
        if p == "/api/search" and method == "GET" and status == 200:
            picked.append(ms)
    avg = sum(picked) / len(picked)
    assert abs(avg - round(avg)) > 0.05, avg
    return case(
        "sd-search-latency",
        "Average latency from JSONL",
        "/workspace/requests.jsonl has one JSON object per line with method, path, status and ms (latency in milliseconds). What is the average latency of GET requests to exactly /api/search (not /api/search/suggest) that returned status 200? Round to the nearest whole number and reply with only that number.",
        [W("requests.jsonl", "\n".join(lines) + "\n")],
        number(round(avg)),
    )


def sd_low_stock(rng):
    names = ["Bolt M4", "Nut M4", "Washer, steel", "Hinge", "Bracket, L", "Spring", "Gasket", "Cable tie", "Rivet", "Clamp, hose", "Anchor", "Pin"]
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["sku", "name", "qty", "price"])
    low = []
    for i, n in enumerate(names):
        sku = "HW-%03d" % (i * 13 + 5)
        qty = rng.choice([rng.randrange(0, 10), rng.randrange(10, 200)])
        if i == 3:
            qty = 10
        price = rng.randrange(5, 2000) / 100
        w.writerow([sku, n, qty, "%.2f" % price])
        if qty < 10:
            low.append({"sku": sku, "qty": qty, "price": float("%.2f" % price)})
    assert 3 <= len(low) <= 8, low
    return case(
        "sd-low-stock",
        "CSV rows to JSON objects",
        "/workspace/inventory.csv has the columns sku, name, qty, price (some names contain commas and are quoted). Write /workspace/low_stock.json containing a JSON array with one object per row whose qty is less than 10, in the same order as the CSV. Each object must have exactly the keys sku (string), qty (number) and price (number).",
        [W("inventory.csv", buf.getvalue())],
        jq_equals("/workspace/low_stock.json", low),
        max_turns=12,
    )


def sd_unique_contacts(rng):
    base = ["ada@lark.dev", "grace@navy.mil", "linus@kernel.org", "ken@bell-labs.com", "dmr@bell-labs.com", "alan@bletchley.uk", "radia@perlman.net", "edsger@tue.nl", "frances@ibm.com", "barbara@mit.edu", "john@backus.org", "margaret@nasa.gov", "hedy@lamarr.at", "katherine@nasa.gov"]
    a = rng.sample(base, 10)
    b = rng.sample(base, 9)

    def mangle(e):
        r = rng.random()
        if r < 0.3:
            return e.upper()
        if r < 0.5:
            return " " + e.capitalize()
        return e

    def write(rows):
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["name", "email"])
        for e in rows:
            w.writerow([e.split("@")[0].capitalize(), mangle(e)])
        return buf.getvalue()

    uniq = len({e.lower() for e in a + b})
    assert uniq < len(a) + len(b)
    return case(
        "sd-unique-contacts",
        "Dedupe emails across files",
        "/workspace/contacts_a.csv and /workspace/contacts_b.csv each have the columns name, email. How many unique email addresses are there across both files combined? Treat addresses that differ only in letter case or surrounding whitespace as the same address. Reply with only the number.",
        [W("contacts_a.csv", write(a)), W("contacts_b.csv", write(b))],
        number(uniq),
    )


def write_suite(sid, title, desc, cases):
    suite = {"id": sid, "title": title, "description": desc, "envType": "sim", "cases": cases}
    with open(os.path.join(SUITES, sid + ".json"), "w") as f:
        json.dump(suite, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    rng = random.Random(20251028)
    tb = [
        tb_find_port(), tb_write_todo(), tb_edit_line(), tb_count_errors(rng), tb_top_5xx_ip(rng),
        tb_png_bytes(rng), tb_shipped_orders(rng), tb_missing_report(), tb_fix_bad_reading(rng), tb_jpg_manifest(rng),
    ]
    write_suite("tool-basics", "Tool basics", "Find, read, write and edit files; small pipelines; recover from a failing command.", tb)
    sales, rows = sales_csv(rng)
    sd = [
        sd_west_units(sales, rows), sd_widget_revenue(sales, rows), sd_country_join(rng), sd_event_counts(rng),
        sd_active_emails(rng), sd_search_latency(rng), sd_low_stock(rng), sd_unique_contacts(rng),
    ]
    write_suite("shell-data", "Shell data tasks", "CSV, JSON and JSONL wrangling with grep, awk, jq or python3.", sd)
    for c in tb + sd:
        print(c["id"], json.dumps(c["check"])[:110])


if __name__ == "__main__":
    main()
