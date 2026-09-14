#!/usr/bin/env python3
"""Names a Python file READS but never BINDS anywhere: the shape of the 13 Sep 2026 render outage,
where PR #399 deleted the INTRO_LOCAL constant and left four uses. Python only raises at the moment
the function runs, so the nightly render died clip by clip while every test that did not call
intro_clip() stayed green. Scope-blind on purpose: a name bound ANYWHERE in the file counts as bound, so this catches only names
never defined at all (the deleted-constant shape) and raises no scope false positives. It is not pyflakes.
A file with a star import cannot be judged and reports [] (none of the estate scripts uses one).
Usage: py_undefined_names.py FILE [FILE...] -> JSON {file: [names]}."""
import ast, builtins, json, sys


def undefined_names(path):
    tree = ast.parse(open(path).read(), path)
    if any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree)):
        return []   # star import: every name may come from elsewhere; not judged (see docstring)
    bound = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__spec__", "__builtins__"}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names: bound.add((a.asname or a.name).split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
            if not isinstance(node, ast.ClassDef):
                args = node.args
                for a in args.args + args.posonlyargs + args.kwonlyargs: bound.add(a.arg)
                if args.vararg: bound.add(args.vararg.arg)
                if args.kwarg: bound.add(args.kwarg.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            bound.update(node.names)
        elif isinstance(node, ast.arg):
            bound.add(node.arg)
        elif getattr(ast, 'MatchAs', None) and isinstance(node, ast.MatchAs) and node.name:
            bound.add(node.name)
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    return sorted(used - bound)


if __name__ == "__main__":
    print(json.dumps({p: undefined_names(p) for p in sys.argv[1:]}))
