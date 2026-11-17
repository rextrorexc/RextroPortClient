import sys, os, json, zipfile, stat

zpath, dest = sys.argv[1], sys.argv[2]
root = os.path.realpath(dest)
res = {"entries": 0, "extracted": 0, "skipped": []}

def fix_name(info):
    n = info.filename
    if not (info.flag_bits & 0x800):
        try: n = n.encode("cp437").decode("utf-8")
        except Exception: pass
    return n.replace("\\", "/")

with zipfile.ZipFile(zpath) as z:
    for info in z.infolist():
        res["entries"] += 1
        name = fix_name(info)
        parts = [p for p in name.split("/") if p not in ("", ".")]
        if not parts or ".." in parts or os.path.isabs(name):
            res["skipped"].append({"name": name, "why": "unsafe path"}); continue
        target = os.path.join(root, *parts)
        try:
            mode = (info.external_attr >> 16) & 0xFFFF
            if name.endswith("/") or info.is_dir():
                os.makedirs(target, exist_ok=True); res["extracted"] += 1; continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if stat.S_ISLNK(mode):
                if os.path.lexists(target): os.remove(target)
                os.symlink(z.read(info).decode("utf-8", "surrogateescape"), target)
            else:
                with z.open(info) as src, open(target, "wb") as out:
                    while True:
                        b = src.read(1 << 20)
                        if not b: break
                        out.write(b)
                os.chmod(target, (mode & 0o777) or 0o644)
            res["extracted"] += 1
        except Exception as e:
            res["skipped"].append({"name": name, "why": str(e)})
print(json.dumps(res))
