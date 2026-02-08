/**
 * JS vs WASM implode kimenet összehasonlítása – hibakereséshez.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { implode } from '@src/simple/index.js'
import { implodeBinaryLargeWasm } from '@src/simple/implode-wasm.js'
import { pathToRepoRoot } from '@bin/helpers.js'

const rootDir = pathToRepoRoot()
const testFilePath = resolve(rootDir, '../pkware-test-files/arx-fatalis/level1/level1.llf.unpacked')
const fullInput = new Uint8Array(readFileSync(testFilePath))
const useSmallInput = process.argv.includes('--small')
const input = (useSmallInput ? fullInput.slice(0, 100) : fullInput).buffer

const jsResult = implode(input, 'binary', 'large')
const wasmResult = implodeBinaryLargeWasm(input)
if (wasmResult === null) {
  console.error('WASM nem elérhető')
  process.exit(1)
}

const jsView = new Uint8Array(jsResult)
const wasmView = new Uint8Array(wasmResult)

console.log('JS length:', jsView.length)
console.log('WASM length:', wasmView.length)

let firstDiff = -1
const maxCompare = Math.min(jsView.length, wasmView.length)
for (let index = 0; index < maxCompare; index++) {
  if (jsView[index] !== wasmView[index]) {
    firstDiff = index
    break
  }
}
if (firstDiff === -1 && jsView.length !== wasmView.length) {
  firstDiff = maxCompare
}

if (firstDiff >= 0) {
  console.log('Első különbség index:', firstDiff)
  const contextStart = Math.max(0, firstDiff - 4)
  const contextEnd = Math.min(maxCompare, firstDiff + 5)
  console.log(
    'JS környék:',
    [...jsView.slice(contextStart, contextEnd)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  )
  console.log(
    'WASM környék:',
    [...wasmView.slice(contextStart, contextEnd)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  )
} else {
  console.log('Kimenetek megegyeznek')
}
