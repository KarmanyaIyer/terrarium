f=$(find /workspace -name settings.ini)
awk '/^\[/{s=$0} s=="[server]" && $1=="port"{print $3}' "$f"
