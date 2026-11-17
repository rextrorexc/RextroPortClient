# Rextro Port Client

Local web tool that ports a Minecraft client's source code to another Minecraft version (1.16.5 and up).

Drop the client `.zip`, pick the target version, press **Port et**. The file tree updates live,
original and ported code show side by side, and the result downloads as a `.zip`.

## Run

No install needed on Windows: `start.bat` uses Node.js if present, otherwise downloads a portable copy
(one time, into `runtime/`). No Python required.

```bat
start.bat
```

Linux / macOS (needs Node.js 22+):

```bash
./start.sh
```

JDK 21 is only needed for the optional **Derle** build step.

Opens on `http://localhost:3917` (next free port if taken).

## What it does

- Updates `gradle.properties`, `build.gradle`, `fabric.mod.json`, `pack.mcmeta`, `mods.toml` in place (formatting and `${...}` templates kept).
- Fabric yarn / loader / fabric-api versions resolved from Fabric meta.
- Generates `gradlew` + wrapper (Gradle 8.12.1) when missing and bumps Fabric Loom to a JDK 21 compatible version.
- Safe API renames only (e.g. `LiteralText` -> `Text.literal`). Game logic is never rewritten.
- Known breaking APIs (Matrix4f, DrawContext, NBT components, Identifier) are reported with file:line, not edited.
- Non UTF-8 files are left byte-identical. After porting, every file is verified against the original.
- Optional **Derle** button runs `gradlew build -x test` on a scratch copy.
