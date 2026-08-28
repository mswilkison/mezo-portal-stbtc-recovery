// Creates .env from the example on first run and, unlike the previous
// `cp -n`, appends any keys a pre-existing .env is missing: dotenv-safer
// requires every example key to be PRESENT (empty values are fine, absent
// ones throw before hardhat even loads), so adding a key to the example
// used to break every hardhat command for anyone with an older .env.
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const exampleFile = process.env.CI ? ".env.ci.example" : ".env.example"
const examplePath = path.join(root, exampleFile)
const envPath = path.join(root, ".env")

function keysOf(content) {
  return content
    .split("\n")
    .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/))
    .filter(Boolean)
    .map((match) => match[1])
}

const example = fs.readFileSync(examplePath, "utf8")

if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, example)
  process.exit(0)
}

const env = fs.readFileSync(envPath, "utf8")
const existing = new Set(keysOf(env))
const missing = keysOf(example).filter((key) => !existing.has(key))

if (missing.length > 0) {
  const suffix = env.endsWith("\n") || env.length === 0 ? "" : "\n"
  const added = missing.map((key) => `${key}=`).join("\n")
  fs.writeFileSync(
    envPath,
    `${env}${suffix}# Added by prepare:env (new keys from ${exampleFile}).\n${added}\n`,
  )
  // eslint-disable-next-line no-console
  console.error(`prepare:env added missing keys to .env: ${missing.join(", ")}`)
}
