import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

let wasmModule: { implode_binary_large: (input: Uint8Array) => Uint8Array } | null = null

export function implodeBinaryLargeWasm(input: ArrayBufferLike): ArrayBuffer | null {
  if (wasmModule === null) {
    try {
      const wasmPath = join(__dirname, '..', '..', 'wasm', 'pkg', 'node_pkware_wasm.js')
      wasmModule = require(wasmPath) as { implode_binary_large: (input: Uint8Array) => Uint8Array }
    } catch (error) {
      return null
    }
  }

  const inputView = new Uint8Array(input)
  const result = wasmModule.implode_binary_large(inputView)
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength)
}

export function isWasmAvailable(): boolean {
  try {
    if (wasmModule !== null) {
      return true
    }
    const wasmPath = join(__dirname, '..', '..', 'wasm', 'pkg', 'node_pkware_wasm.js')
    require.resolve(wasmPath)
    return true
  } catch {
    return false
  }
}
