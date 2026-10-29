"""Let pydantic models live in Cython-compiled modules.

The service is compiled before it is deployed, so no readable source ships.
Compiling turns a model's methods into Cython's own function type. Pydantic
does not recognise that type, takes each method for a field with no
annotation, and refuses to build the model ("A non-annotated attribute was
detected"). This adds the type to the ones pydantic skips.

Uncompiled code has no such type, so in development this changes nothing.
Import it before any pydantic model is defined.
"""

from pydantic._internal import _model_construction as _mc

_CYTHON_FUNCTION_TYPES = frozenset({"cython_function_or_method", "fused_cython_function"})


class _CythonFunctionMeta(type):
    def __instancecheck__(cls, obj):
        return type(obj).__name__ in _CYTHON_FUNCTION_TYPES


class CythonFunction(metaclass=_CythonFunctionMeta):
    """Matches a compiled function in isinstance(), without importing Cython."""


# pydantic calls default_ignored_types() each time it builds a model, through
# the module attribute, so replacing the attribute reaches every model.
if not getattr(_mc, "_tscan_compiled_compat", False):
    _original = _mc.default_ignored_types

    def _with_cython_functions():
        return _original() + (CythonFunction,)

    _mc.default_ignored_types = _with_cython_functions
    _mc._tscan_compiled_compat = True
