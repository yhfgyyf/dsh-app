import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const originalHash = '9e86429fa1f7c4d759b5e4690e091574227305f452391c2e101311ac73b2d8bd';
const marker = '// DSH Desktop workspace payload layout v1';
const sha = text => createHash('sha256').update(text).digest('hex');
const replacements = [
  ['import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat }', 'import { cp, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat }'],
  ['!["x64", "arm64"].includes(arch)', '!["x64", "arm64", "loong64"].includes(arch) || arch === "loong64" && (platform !== "linux" || value.abi !== "loongarch64-old-world")'],
  ['\t\tarch,\n', '\t\tarch,\n\t\t...arch === "loong64" ? { abi: "loongarch64-old-world" } : {},\n'],
  ['join(dependencies, "node", "bin", windows ? "node.exe" : "node")', 'join(root, "bin", windows ? "node.exe" : "node")'],
  ['join(dependencies, "node", "node_modules")', 'join(root, "node_modules")'],
  ['join(dependencies, "pnpm", "bin", "pnpm.mjs")', 'join(root, "package-manager", "node_modules", "pnpm", "bin", "pnpm.mjs")'],
  ['\t\tpythonDistributions: manifest.pythonPackages\n', '\t\tpythonDistributions: manifest.pythonPackages,\n\t\tofficeExample: join(root, "examples", "office-smoke.py")\n'],
  ['\t\t[paths.python, "file"],', '\t\t[paths.python, "file"],\n\t\t[paths.officeExample, "file"],'],
  ['async function compatibleManifest(source) {', `${marker}
async function validateLoongRuntime(source, manifest) {
	if (manifest.arch !== "loong64") return;
	const version = process.report.getReport().header.glibcVersionRuntime;
	const [major, minor] = String(version).split(".").map(Number);
	if (!(major > 2 || major === 2 && minor >= 28)) throw new Error("primary runtime: Kylin requires glibc 2.28 or newer");
	for (const path of [process.execPath, workspaceDependencyPaths(source, manifest).python]) {
		const file = await open(path, "r");
		try {
			const header = Buffer.alloc(64);
			const { bytesRead } = await file.read(header, 0, 64, 0);
			if (bytesRead !== 64 || header.readUInt32LE(0) !== 0x464c457f || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 258 || header.readUInt32LE(48) !== 3) throw new Error("primary runtime: expected old-world LoongArch ELF flags 0x3");
		} finally { await file.close(); }
	}
}
async function compatibleManifest(source) {`],
  ['\treturn manifest;\n}', '\tawait validateLoongRuntime(source, manifest);\n\treturn manifest;\n}'],
  ['Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, and XlsxWriter. Use these libraries for Office files unless the user or workspace instructions select another environment. When Node.js and pnpm paths are returned, run pnpm with that Node executable and pnpm script path.', 'Read pythonDistributions for the actual pinned library inventory; numpy and pandas are not bundled. Use the bundled Office/PDF libraries unless the user or workspace selects another environment. officeExample is an offline XLSX/DOCX/editable PPTX/PDF/PNG round-trip script: run the returned Python with -I -B, that script, --output <new empty folder>, and --node <returned Node>. Keep the app runtime unchanged; install extra libraries in a workspace virtual environment. Run pnpm with the returned Node, --expose-internals, and pnpm script path.'],
  ['\t\t\t\t\tpythonDistributions: {', '\t\t\t\t\tofficeExample: { type: "string", required: true, description: "Bundled offline Office library example script." },\n\t\t\t\t\tpythonDistributions: {'],
];

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Pinned workspace dependency source contract changed');
  return source.replace(before, after);
}

/** Adapt only the pinned Desktop copy; preserve unknown upstream/local edits. */
export function patchWorkspaceDependencySource(source) {
  if (source.includes(marker)) {
    let original = source;
    for (const [before, after] of [...replacements].reverse()) original = replaceOnce(original, after, before);
    assert.equal(sha(original), originalHash, 'Unknown workspace dependency changes preserved');
    return source;
  }
  assert.equal(sha(source), originalHash, 'Unknown workspace dependency changes preserved');
  for (const [before, after] of replacements) source = replaceOnce(source, before, after);
  return source;
}

export async function applyWorkspaceDependencies({ runtimeNodeModules = join(root, '.runtime/node_modules') } = {}) {
  const base = join(runtimeNodeModules, '@deepseek-ai/dsh-tool-workspace-dependencies');
  const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.7-alpha.1');
  const path = join(base, 'lib/index.js');
  const source = await readFile(path, 'utf8');
  const patched = patchWorkspaceDependencySource(source);
  if (patched !== source) await writeFile(path, patched);
  return { changed: patched !== source, sha256: sha(patched) };
}
