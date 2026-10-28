cat > /tmp/low.py <<'PY'
import csv, json
rows = [{"sku": r["sku"], "qty": int(r["qty"]), "price": float(r["price"])} for r in csv.DictReader(open("/workspace/inventory.csv")) if int(r["qty"]) < 10]
json.dump(rows, open("/workspace/low_stock.json", "w"))
PY
python3 /tmp/low.py
