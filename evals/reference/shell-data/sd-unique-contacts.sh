tail -n +2 -q /workspace/contacts_a.csv /workspace/contacts_b.csv | cut -d, -f2 | tr -d ' ' | tr 'A-Z' 'a-z' | sort -u | wc -l | tr -d ' '
