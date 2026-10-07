
import importlib
for m in ["numpy","sentence_transformers","onnxruntime","sklearn","faiss","torch","openai"]:
    try:
        importlib.import_module(m); print("  OK  ", m)
    except Exception as e:
        print("  --  ", m, "(", type(e).__name__, ")")
