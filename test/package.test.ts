import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { after, describe, it } from "node:test"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string
  exports: Record<string, { import?: string; types?: string } | string>
  files: string[]
  scripts: Record<string, string>
}

type PackedFile = { path: string; size: number }
type Packed = { filename: string; files: PackedFile[] }

const temp = mkdtempSync(join(tmpdir(), "usage-sidebar-pack-"))
after(() => rmSync(temp, { recursive: true, force: true }))

function pack(): Packed {
  // Nested `npm pack` inherits npm_config_dry_run from `npm publish --dry-run`,
  // which would skip writing the tarball we need to inspect.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "npm_config_dry_run") delete env[key]
  }
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
  )
  const parsed = JSON.parse(output) as Packed[]
  assert.equal(parsed.length, 1)
  return parsed[0]
}

describe("package manifest", () => {
  it("points every export at a built artifact", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json") continue
      assert.equal(typeof target, "object", `${subpath} should declare import/types`)
      const entry = target as { import?: string; types?: string }
      assert.ok(entry.import?.startsWith("./dist/"), `${subpath} import must live in dist`)
      assert.ok(entry.types?.startsWith("./dist/"), `${subpath} types must live in dist`)
      for (const file of [entry.import, entry.types]) {
        assert.ok(existsSync(join(root, file!)), `missing ${file} (run npm run build)`)
      }
    }
  })

  it("ships dist and builds before publishing", () => {
    assert.ok(pkg.files.includes("dist"))
    assert.equal(pkg.scripts.prepack, "npm run build")
    assert.match(pkg.scripts.prepublishOnly, /verify/)
  })
})

describe("build output", () => {
  it("resolves every relative import in dist", () => {
    const dist = join(root, "dist")
    const entries = readdirSync(dist).filter((name) => name.endsWith(".js"))
    assert.deepEqual(entries.slice().sort(), ["data.js", "format.js", "panel.js", "tui.js", "view.js"])
    for (const entry of entries) {
      const code = readFileSync(join(dist, entry), "utf8")
      const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier) => specifier.startsWith("."))
      for (const specifier of specifiers) {
        assert.ok(specifier.endsWith(".js"), `${entry} imports extensionless ${specifier}`)
        assert.ok(existsSync(join(dist, specifier)), `${entry} imports missing ${specifier}`)
      }
    }
  })

  it("compiles JSX through the opentui runtime", () => {
    for (const entry of ["panel.js", "tui.js"]) {
      const code = readFileSync(join(root, "dist", entry), "utf8")
      assert.match(code, /@opentui\/solid\/jsx-runtime/, `${entry} lost its JSX transform`)
    }
  })
})

describe("packed tarball", () => {
  it("contains everything a consumer needs and nothing extra", () => {
    const packed = pack()
    const files = packed.files.map((file) => file.path)
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/tui.js",
      "dist/tui.d.ts",
      "dist/panel.js",
      "dist/data.js",
      "dist/format.js",
      "dist/view.js",
    ]) {
      assert.ok(files.includes(required), `${required} missing from tarball`)
    }
    for (const leaked of ["tui.tsx", "panel.tsx", "data.ts", "format.ts", "tsconfig.json", "tsconfig.build.json"]) {
      assert.equal(files.includes(leaked), false, `${leaked} should not be published`)
    }
    assert.equal(files.some((file) => file.startsWith("test/")), false, "tests should not be published")
    for (const file of packed.files) assert.ok(file.size > 0, `${file.path} is empty`)
  })

  it("installs into a clean consumer and resolves its exports", () => {
    const packed = pack()
    const consumer = join(temp, "consumer")
    const installDir = join(consumer, "node_modules", "@shaojc", "opencode-usage-sidebar")
    mkdirSync(installDir, { recursive: true })
    execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", installDir, "--strip-components", "1"])
    for (const dependency of ["@opencode", "@opentui", "solid-js"]) {
      mkdirSync(join(consumer, "node_modules", dirname(dependency)), { recursive: true })
    }
    for (const dependency of ["@opencode", "@opentui", "solid-js"]) {
      execFileSync("ln", ["-s", join(root, "node_modules", dependency), join(consumer, "node_modules", dependency)])
    }

    const script = `
      const direct = await import("${pkg.name}/tui")
      const root = await import("${pkg.name}")
      if (direct.default.id !== "usage-sidebar") throw new Error("bad id: " + direct.default.id)
      if (typeof root.default.setup !== "function") throw new Error("missing setup")
      console.log("consumer-ok")
    `
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: consumer,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    assert.equal(output.trim(), "consumer-ok")
  })
})
