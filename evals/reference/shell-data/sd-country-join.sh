cat > /tmp/join.py <<'PY'
import csv
country = {r["id"]: r["country"] for r in csv.DictReader(open("/workspace/customers.csv"))}
tot = {}
for r in csv.DictReader(open("/workspace/orders.csv")):
    c = country[r["customer_id"]]
    tot[c] = tot.get(c, 0) + round(float(r["amount"]) * 100)
with open("/workspace/totals.csv", "w") as f:
    f.write("country,total\n")
    for c, v in sorted(tot.items(), key=lambda kv: -kv[1]):
        f.write("%s,%.2f\n" % (c, v / 100))
PY
python3 /tmp/join.py
