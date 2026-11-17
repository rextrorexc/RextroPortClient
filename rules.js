// Port rules. Policy: only mechanical, behavior-preserving renames are auto-applied.
// Anything touching combat/rotation logic is NEVER edited, only reported.

const VERSIONS = [
  ['1.16.5', 6, 8], ['1.17.1', 7, 16], ['1.18.2', 8, 17], ['1.19.2', 9, 17],
  ['1.19.4', 13, 17], ['1.20.1', 15, 17], ['1.20.2', 18, 17], ['1.20.4', 22, 17],
  ['1.20.6', 32, 21], ['1.21', 34, 21], ['1.21.1', 34, 21], ['1.21.3', 42, 21],
  ['1.21.4', 46, 21],
].map(([mc, packFormat, java]) => ({ mc, packFormat, java }));

const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};

// Lines matching this are protected: rules never edit them (module logic stays intact).
const PROTECTED_LINE = /\b(rotation|rotate|yaw|pitch|gcd|sensitivity|aimassist|killaura|aura|reach|velocity|knockback|bypass|grim|raytrace|smooth)\w*/i;
const PROTECTED_FILE = /(aura|rotation|combat|aim|reach|velocity|criticals|antikb|scaffold|speed|fly|bypass)/i;

// from/to = inclusive-exclusive MC range where rule applies (target >= from).
const SOURCE_RULES = [
  { id: 'literaltext', since: '1.19', re: /new\s+LiteralText\s*\(/g, to: 'Text.literal(', note: 'LiteralText removed in 1.19' },
  { id: 'translatabletext', since: '1.19', re: /new\s+TranslatableText\s*\(/g, to: 'Text.translatable(', note: 'TranslatableText removed in 1.19' },
  { id: 'literaltext-import', since: '1.19', re: /^import\s+net\.minecraft\.text\.(LiteralText|TranslatableText);\s*$/gm, to: '', note: 'stale import' },
];

// Detect-only: known breaking APIs. Reported with file:line, never auto-edited.
const FLAG_RULES = [
  { since: '1.17', re: /\bMatrix4f\b|\bMatrix3f\b/, note: 'Matrix classes changed (1.19.3 -> JOML)' },
  { since: '1.19.3', re: /\bDrawableHelper\b/, note: 'DrawableHelper -> DrawContext in 1.20' },
  { since: '1.20', re: /\bMatrixStack\b.*\b(fill|drawTexture|drawText)\b/, note: 'GUI draw calls moved to DrawContext' },
  { since: '1.19', re: /\bPlayerMoveC2SPacket\b/, note: 'movement packet constructors differ; verify manually' },
  { since: '1.20.5', re: /\bItemStack\b.*\.(getNbt|getOrCreateNbt|setNbt)\b/, note: 'NBT replaced by data components in 1.20.5' },
  { since: '1.21', re: /\bnew\s+Identifier\s*\(/, note: 'Identifier ctor private in 1.21; use Identifier.of' },
  { since: '1.17', re: /\bnet\.minecraft\.client\.util\.math\.MatrixStack\b/, note: 'MatrixStack package moved' },
];

module.exports = { VERSIONS, cmp, PROTECTED_LINE, PROTECTED_FILE, SOURCE_RULES, FLAG_RULES };
