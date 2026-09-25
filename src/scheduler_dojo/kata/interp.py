"""The Kata tree-walking interpreter: `Interp` + `run_module`.

Executes the frozen `ast` node shapes from `kata.ast` against a `builtins.Env`. Values are plain
Python (int/float/bool/None + list/tuple) plus the opaque record wrappers of `builtins`.

Contract highlights (spec.md):
* one interpreter "step" per statement and per expression node, plus one per builtin call —
  exhausting `env.step_budget` raises `StepBudgetError("your kata ran out of breath on line N")`;
* user `def`s recurse with a hard depth cap (200 frames -> EngineError code `max_depth`);
* the **order slot contract**: `run_module` returns a `ModuleResult(value, scope)`; the driver
  reads the `key` binding (or a `return` value) from it;
* every kata-visible failure is an `EngineError` with a spec §9 code and the statement's line.
"""

from __future__ import annotations

from collections import namedtuple

from scheduler_dojo.kata import ast
from scheduler_dojo.kata.builtins import TupleRec, NameVal, sortable, truth
from scheduler_dojo.kata.errors import EngineError

_MAX_LIST = 200_000  # safety cap on '|' concatenation result size (DoS guard)

MAX_DEPTH = 200

ModuleResult = namedtuple("ModuleResult", ["value", "scope"])


class _Return(Exception):
    """Internal: unwinds a module/def body with a value."""

    def __init__(self, value) -> None:
        self.value = value


class Interp:
    def __init__(self, env, defs) -> None:
        self.env = env
        if isinstance(defs, dict):
            self.defs = defs
        else:
            self.defs = {d.name: d for d in (defs or ())}
        self.frames = 0
        self.line = 0

    # --- entry points ----------------------------------------------------------
    def run_module(self, module: ast.Module, scope: dict | None = None) -> ModuleResult:
        scope = dict(scope or {})
        value = None
        try:
            self.exec_block(module.body, scope)
        except _Return as r:
            value = r.value
        return ModuleResult(value, scope)

    # --- statements ------------------------------------------------------------
    def exec_block(self, stmts, scope: dict) -> None:
        for st in stmts:
            self.exec_stmt(st, scope)

    def exec_stmt(self, st, scope: dict) -> None:
        self.line = getattr(st, "line", self.line) or self.line
        self.env.step(self.line)
        t = type(st)
        if t is ast.Assign:
            scope[st.target] = self.eval(st.value, scope)
        elif t is ast.Remember:
            self.env.remember(st.target, self.eval(st.value, scope), line=self.line)
        elif t is ast.If:
            if truth(self.eval(st.test, scope)):
                self.exec_block(st.body, scope)
                return
            for test, body in st.elifs:
                if truth(self.eval(test, scope)):
                    self.exec_block(body, scope)
                    return
            if st.els:
                self.exec_block(st.els, scope)
        elif t is ast.For:
            items = self._iterable(self.eval(st.iter, scope))
            for item in list(items):
                scope[st.target] = item
                self.exec_block(st.body, scope)
        elif t is ast.While:
            while truth(self.eval(st.test, scope)):
                self.exec_block(st.body, scope)
        elif t is ast.Return:
            raise _Return(None if st.value is None else self.eval(st.value, scope))
        elif t is ast.Pass:
            pass
        elif t is ast.ExprStmt:
            self.eval(st.value, scope)
        else:
            raise EngineError(f"cannot run {t.__name__}", code="type", line=self.line)

    def _iterable(self, v):
        if isinstance(v, (list, tuple)):
            return list(v)
        if isinstance(v, TupleRec):
            return list(v.items)
        self._err("only lists can be iterated", "type")

    # --- expressions -----------------------------------------------------------
    def eval(self, node, scope: dict):
        self.env.step(self.line)
        t = type(node)
        if t is ast.Int:
            return int(node.value)
        if t is ast.Float:
            return float(node.value)
        if t is ast.Bool:
            return bool(node.value)
        if t is ast.Nil:
            return None
        if t is ast.Str:
            return NameVal(str(node.value))
        if t is ast.Name:
            if node.id in scope:
                return scope[node.id]
            self._err(f"undefined name '{node.id}'", "undefined_name")
        if t is ast.Attribute:
            base = self.eval(node.value, scope)
            return self.env.getattr(base, node.attr, line=self.line)
        if t is ast.Tuple:
            elts = [self.eval(e, scope) for e in node.elts]
            self._no_names(elts, "a tuple")
            return tuple(elts)
        if t is ast.ListLit:
            elts = [self.eval(e, scope) for e in node.elts]
            self._no_names(elts, "a list")
            return elts
        if t is ast.Call:
            return self._call(node, scope)
        if t is ast.BinOp:
            return self._binop(node, scope)
        if t is ast.UnaryOp:
            v = self.eval(node.operand, scope)
            if node.op == "-":
                if isinstance(v, NameVal) or not isinstance(v, (int, float)):
                    self._err("unary - needs a number", "type")
                return -v
            if node.op == "not":
                return not truth(v)
            self._err(f"unknown unary op '{node.op}'", "type")
        if t is ast.BoolOp:
            return self._boolop(node, scope)
        if t is ast.Ternary:
            return self.eval(node.then if truth(self.eval(node.cond, scope))
                             else node.otherwise, scope)
        self._err(f"cannot evaluate {t.__name__}", "type")

    def _boolop(self, node, scope: dict):
        if node.op == "and":
            result = True
            for v in node.values:
                result = truth(self.eval(v, scope))
                if not result:
                    break
            return result
        if node.op == "or":
            result = False
            for v in node.values:
                result = truth(self.eval(v, scope))
                if result:
                    break
            return result
        self._err(f"unknown bool op '{node.op}'", "type")

    def _call(self, node: ast.Call, scope: dict):
        name = node.func
        args = [self.eval(a, scope) for a in node.args]
        kwargs: dict[str, object] = {}
        for kname, knode in node.kwargs:
            if kname == "key" and isinstance(knode, ast.Name) and knode.id in self.defs:
                kwargs["key_fn"] = self._def_caller(knode.id)
            elif kname == "key":
                kwargs["key"] = self.eval(knode, scope)
            else:
                kwargs[kname] = self.eval(knode, scope)
        # user defs win over builtins of the same name? No — builtins are reserved names.
        if self.env.knows(name):
            self.env.check_builtin(name, len(args), self.line)
            if name == "sorted":  # needs def-callback power; delegate to a bound helper
                key_fn = kwargs.get("key_fn")
                return self.env.bi_sorted(*args, key_fn=key_fn)
            return self.env.invoke(name, args, {})
        if name in self.defs:
            return self._call_def(name, args, kwargs)
        self._err(f"no builtin or def named '{name}'", "no_such_builtin")

    def _def_caller(self, name: str):
        def apply(value):
            return self._call_def(name, [value], {})
        return apply

    def _call_def(self, name: str, args: list, kwargs: dict):
        d = self.defs[name]
        nparams = len(d.params)
        if kwargs:
            if len(args) + len(kwargs) != nparams or set(kwargs) - set(d.params):
                self._err(f"def '{name}' takes {nparams} args", "arity")
            positional = list(args) + [kwargs[p] for p in d.params[len(args):]]
            args = positional
        if len(args) != nparams:
            self._err(f"def '{name}' takes {nparams} args, got {len(args)}", "arity")
        if self.frames >= MAX_DEPTH:
            self._err("recursion too deep", "max_depth")
        local = dict(zip(d.params, args))
        self.frames += 1
        try:
            self.exec_block(d.body, local)
        except RecursionError:  # Python's own limit tripped first -> report as kata max_depth
            self.frames -= 1
            self._err("recursion too deep", "max_depth")
        except _Return as r:
            self.frames -= 1
            return r.value
        else:
            self.frames -= 1
        return None  # fell off the end: nil

    # --- operators ---------------------------------------------------------------
    def _binop(self, node: ast.BinOp, scope: dict):
        op = node.op
        left = self.eval(node.left, scope)
        right = self.eval(node.right, scope)
        if op in ("==", "!="):
            eq = self._eq(left, right)
            return eq if op == "==" else not eq
        if op in ("<", "<=", ">", ">="):
            return self._cmp(op, left, right)
        if op == "|":
            if isinstance(left, list) and isinstance(right, list):
                # Bound allocation: `xs = xs | xs` doubles per step and would OOM-kill the
                # process (uncaught by the step budget). A cap makes it a clean fallback.
                if len(left) + len(right) > _MAX_LIST:
                    self._err("list too large to concatenate", "policy")
                return list(left) + list(right)
            if isinstance(left, tuple) and isinstance(right, tuple):
                return tuple(left) + tuple(right)
            self._err("'|' concatenates lists", "type")
        # arithmetic
        if isinstance(left, NameVal) or isinstance(right, NameVal):
            self._err("a name cannot be used in arithmetic", "type")
        lk = isinstance(left, (int, float)) and not isinstance(left, NameVal)
        rk = isinstance(right, (int, float)) and not isinstance(right, NameVal)
        if not (lk and rk):
            self._err(f"cannot do '{op}' on those values", "type")
        lb, rb = isinstance(left, bool), isinstance(right, bool)
        l = int(left) if lb else left
        r = int(right) if rb else right
        try:
            if op == "+":
                return l + r
            if op == "-":
                return l - r
            if op == "*":
                return l * r
            if op == "/":
                if r == 0:
                    self._err("division by zero", "type")
                return l / r
            if op == "//":
                if r == 0:
                    self._err("division by zero", "type")
                return l // r
            if op == "%":
                if r == 0:
                    self._err("division by zero", "type")
                return l % r
        except ZeroDivisionError:
            self._err("division by zero", "type")
        self._err(f"unknown operator '{op}'", "type")

    def _eq(self, left, right) -> bool:
        if left is None or right is None:
            return left is None and right is None
        if isinstance(left, NameVal) or isinstance(right, NameVal):
            if isinstance(left, NameVal) and isinstance(right, NameVal):
                return left.value == right.value
            self._err("a name can only be compared with a name", "type")
        if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
            return len(left) == len(right) and all(self._eq(a, b) for a, b in zip(left, right))
        if isinstance(left, (int, float, bool)) and isinstance(right, (int, float, bool)):
            return bool(left == right)
        # records / mixed: identity equality (never a type error, e.g. `head == nil`)
        return left == right

    def _cmp(self, op: str, left, right):
        if isinstance(left, NameVal) or isinstance(right, NameVal):
            self._err("names only support == and !=", "type")
        if left is None or right is None:
            self._err("nil cannot be ordered", "type")
        if isinstance(left, bool):
            left = int(left)
        if isinstance(right, bool):
            right = int(right)
        ok = (isinstance(left, (int, float)) and isinstance(right, (int, float))) or (
            isinstance(left, tuple) and isinstance(right, tuple))
        if not ok:
            self._err(f"cannot order those values with '{op}'", "type")
        try:
            if op == "<":
                return bool(left < right)
            if op == "<=":
                return bool(left <= right)
            if op == ">":
                return bool(left > right)
            if op == ">=":
                return bool(left >= right)
        except TypeError:
            self._err(f"cannot order those values with '{op}'", "type")
        self._err(f"unknown operator '{op}'", "type")

    # --- helpers -----------------------------------------------------------------
    def _no_names(self, elts, where: str) -> None:
        for e in elts:
            if isinstance(e, NameVal):
                self._err(f"a name cannot be stored in {where}", "type")

    def _err(self, msg: str, code: str):
        raise EngineError(msg, code=code, line=self.line)


def run_module(module: ast.Module, env, defs, scope: dict | None = None) -> ModuleResult:
    """Execute one slot-module body; return (return_value, final_scope)."""
    return Interp(env, defs).run_module(module, scope)
