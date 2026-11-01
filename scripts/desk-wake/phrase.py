import argparse
import hashlib
import json
from pathlib import Path
import sentencepiece

parser = argparse.ArgumentParser()
parser.add_argument("phrase")
args = parser.parse_args()
phrase = " ".join(args.phrase.upper().split())
if not 2 <= len(phrase) <= 60 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ " for c in phrase):
    parser.error("Use 2-60 English letters and spaces")
root = Path(__file__).resolve().parents[2] / "dist/dashboard-v2/wake"
model = root / "bpe.model"
digest = hashlib.sha256(model.read_bytes()).hexdigest()
if digest != "c8a2a0129c4ab8e463164c142f82d25649661b122c8cd0b7aab5c9e80b90ad24":
    parser.error("Matched BPE model integrity failed; rebuild the dashboard")
processor = sentencepiece.SentencePieceProcessor(model_file=str(model))
tokens = processor.encode(phrase, out_type=str)
vocabulary = {line.rsplit(" ", 1)[0] for line in (root / "tokens.txt").read_text().splitlines()}
if any(t not in vocabulary or t in ("<unk>", "<s>", "</s>") for t in tokens):
    parser.error("Phrase is unsupported by the matched vocabulary")
print(json.dumps({"phrase": phrase, "tokens": tokens, "tokenizerSha256": digest}, indent=2))
