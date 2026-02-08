import {
  ChBitsAsc,
  ChCodeAsc,
  DistBits,
  DistCode,
  ExLenBits,
  LenBits,
  LenCode,
  LONGEST_ALLOWED_REPETITION,
} from '@src/constants.js'
import { clamp, getLowestNBitsOf, repeat, nBitsOfOnes } from '@src/functions.js'
import type { CompressionType, DictionarySize } from '@src/simple/types.js'

/**
 * in bytes
 */
const SIZE_OF_HEADER = 3

/**
 * in bytes
 */
const MAX_SIZE_OF_TERMINATION_LITERAL = 2

function getSizeOfMatching(view: Uint8Array, indexA: number, indexB: number): number {
  const limit = clamp(indexB - indexA, 2, LONGEST_ALLOWED_REPETITION)

  for (let i = 2; i <= limit; i++) {
    if (view[indexA + i] !== view[indexB + i]) {
      return i
    }
  }

  return limit
}

const HASH_TABLE_SIZE = 65536

function findRepetitionWithHash(
  view: Uint8Array,
  hashTable: Int32Array,
  cursor: number,
): { size: number; distance: number } {
  const viewLength = view.length
  if (viewLength - cursor < 2) {
    return { size: 0, distance: 0 }
  }

  const hash = (view[cursor] << 8) | view[cursor + 1]
  const matchPosition = hashTable[hash]
  if (matchPosition < 0) {
    hashTable[hash] = cursor
  }

  if (matchPosition >= 0 && cursor - matchPosition >= 2) {
    let size = 2
    if (cursor - matchPosition > 2) {
      size = getSizeOfMatching(view, matchPosition, cursor)
    }
    const distanceBytes = cursor - matchPosition
    return { distance: distanceBytes - 1, size }
  }

  return { size: 0, distance: 0 }
}

export class Implode {
  private inputBuffer: ArrayBufferLike
  private inputBufferView: Uint8Array
  private inputBufferStartIndex: number

  private readonly outputBuffer: ArrayBuffer
  private outputBufferView: Uint8Array
  private outputBufferSize: number

  private dictionarySizeMask: number
  private readonly distCodes: number[]
  private readonly distBits: number[]
  private outBits: number
  private readonly nChBits: number[]
  private readonly nChCodes: number[]

  constructor(input: ArrayBufferLike, compressionType: CompressionType, dictionarySize: DictionarySize) {
    this.dictionarySizeMask = 0
    this.distCodes = structuredClone(DistCode)
    this.distBits = structuredClone(DistBits)
    this.outBits = 0
    this.nChBits = repeat(0, 0x3_06)
    this.nChCodes = repeat(0, 0x3_06)

    this.setupTables(compressionType, dictionarySize)

    this.inputBuffer = input
    this.inputBufferView = new Uint8Array(this.inputBuffer)
    this.inputBufferStartIndex = 0

    this.outputBuffer = new ArrayBuffer(input.byteLength + SIZE_OF_HEADER + MAX_SIZE_OF_TERMINATION_LITERAL)
    this.outputBufferView = new Uint8Array(this.outputBuffer)
    this.outputBufferSize = 0

    this.outputHeader(compressionType, dictionarySize)
    this.processInput(dictionarySize)

    this.writeTerminationLiteral()
  }

  public getResult(): ArrayBuffer {
    return this.outputBuffer.slice(0, this.outputBufferSize)
  }

  private setupTables(compressionType: CompressionType, dictionarySize: DictionarySize): void {
    switch (compressionType) {
      case 'ascii': {
        for (let nCount = 0; nCount < 0x1_00; nCount++) {
          this.nChBits[nCount] = ChBitsAsc[nCount] + 1
          this.nChCodes[nCount] = ChCodeAsc[nCount] * 2
        }

        break
      }

      case 'binary': {
        let nChCode = 0
        for (let nCount = 0; nCount < 0x1_00; nCount++) {
          this.nChBits[nCount] = 9
          this.nChCodes[nCount] = nChCode
          nChCode = getLowestNBitsOf(nChCode, 16) + 2
        }

        break
      }
    }

    switch (dictionarySize) {
      case 'small': {
        this.dictionarySizeMask = nBitsOfOnes(4)
        break
      }

      case 'medium': {
        this.dictionarySizeMask = nBitsOfOnes(5)
        break
      }

      case 'large': {
        this.dictionarySizeMask = nBitsOfOnes(6)
        break
      }
    }

    let nCount = 0x1_00

    for (let i = 0; i < 0x10; i++) {
      for (let nCount2 = 0; nCount2 < 1 << ExLenBits[i]; nCount2++) {
        this.nChBits[nCount] = ExLenBits[i] + LenBits[i] + 1
        this.nChCodes[nCount] = (nCount2 << (LenBits[i] + 1)) | (LenCode[i] * 2) | 1
        nCount = nCount + 1
      }
    }
  }

  private outputHeader(compressionType: CompressionType, dictionarySize: DictionarySize): void {
    switch (compressionType) {
      case 'ascii': {
        this.outputBufferView[0] = 1
        break
      }

      case 'binary': {
        this.outputBufferView[0] = 0
        break
      }
    }

    switch (dictionarySize) {
      case 'small': {
        this.outputBufferView[1] = 4
        break
      }

      case 'medium': {
        this.outputBufferView[1] = 5
        break
      }

      case 'large': {
        this.outputBufferView[1] = 6
        break
      }
    }

    this.outputBufferView[2] = 0
    this.outputBufferSize = 3
  }

  private processInput(dictionarySize: DictionarySize): void {
    if (this.inputBuffer.byteLength === 0) {
      return
    }

    if (this.inputBuffer.byteLength <= 2) {
      this.skipFirstTwoBytes()
      return
    }

    this.skipFirstTwoBytes()

    const hashTable = new Int32Array(HASH_TABLE_SIZE)
    hashTable.fill(-1)

    let view = this.inputBufferView
    hashTable[(view[0] << 8) | view[1]] = 0
    if (view.length > 2) {
      hashTable[(view[1] << 8) | view[2]] = 1
    }

    while (this.inputBuffer.byteLength - this.inputBufferStartIndex > 0) {
      const cursor = this.inputBufferStartIndex
      const data = findRepetitionWithHash(view, hashTable, cursor)

      const { size, distance } = data
      const isFlushable = this.isRepetitionFlushable(size, distance)

      if (isFlushable === false) {
        const byte = this.inputBufferView[this.inputBufferStartIndex]
        this.outputBits(this.nChBits[byte], this.nChCodes[byte])
        this.inputBufferStartIndex = this.inputBufferStartIndex + 1
      } else {
        const byte = size + 0xfe
        this.outputBits(this.nChBits[byte], this.nChCodes[byte])
        if (size === 2) {
          const byte = distance >> 2
          this.outputBits(this.distBits[byte], this.distCodes[byte])
          this.outputBits(2, distance & 3)
        } else {
          switch (dictionarySize) {
            case 'small': {
              const byte = distance >> 4
              this.outputBits(this.distBits[byte], this.distCodes[byte])
              this.outputBits(4, this.dictionarySizeMask & distance)
              break
            }

            case 'medium': {
              const byte = distance >> 5
              this.outputBits(this.distBits[byte], this.distCodes[byte])
              this.outputBits(5, this.dictionarySizeMask & distance)
              break
            }

            case 'large': {
              const byte = distance >> 6
              this.outputBits(this.distBits[byte], this.distCodes[byte])
              this.outputBits(6, this.dictionarySizeMask & distance)
              break
            }
          }
        }

        this.inputBufferStartIndex = this.inputBufferStartIndex + size
      }

      let blockSize: number
      switch (dictionarySize) {
        case 'small': {
          blockSize = 0x4_00
          break
        }

        case 'medium': {
          blockSize = 0x8_00
          break
        }

        case 'large': {
          blockSize = 0x10_00
          break
        }
      }

      if (this.inputBufferStartIndex >= blockSize) {
        this.inputBuffer = this.inputBuffer.slice(blockSize)
        this.inputBufferView = new Uint8Array(this.inputBuffer)
        this.inputBufferStartIndex = this.inputBufferStartIndex - blockSize
        view = this.inputBufferView
        hashTable.fill(-1)
        if (view.length >= 2) {
          hashTable[(view[0] << 8) | view[1]] = 0
        }
        if (view.length >= 3) {
          hashTable[(view[1] << 8) | view[2]] = 1
        }
      }
    }
  }

  private writeTerminationLiteral(): void {
    this.outputBits(this.nChBits.at(-1) as number, this.nChCodes.at(-1) as number)
  }

  /**
   * @returns false - non flushable
   * @returns true - flushable
   * @returns null - flushable, but there might be a better repetition
   */
  private isRepetitionFlushable(size: number, distance: number): boolean | null {
    if (size === 0) {
      return false
    }

    // If we found repetition of 2 bytes, that is 0x1_00 or further back,
    // don't bother. Storing the distance of 0x1_00 bytes would actually
    // take more space than storing the 2 bytes as-is.
    if (size === 2 && distance >= 0x1_00) {
      return false
    }

    if (size >= 8 || this.inputBuffer.byteLength - this.inputBufferStartIndex < 2) {
      return true
    }

    return null
  }

  /**
   * repetitions are at least 2 bytes long,
   * so the initial 2 bytes can be moved to the output as is
   */
  private skipFirstTwoBytes(): void {
    const [byte1, byte2] = this.inputBufferView
    this.outputBits(this.nChBits[byte1], this.nChCodes[byte1])
    this.outputBits(this.nChBits[byte2], this.nChCodes[byte2])
    this.inputBufferStartIndex = this.inputBufferStartIndex + 2
  }

  private outputBits(numberOfBits: number, bitBuffer: number): void {
    if (numberOfBits > 8) {
      this.outputBits(8, bitBuffer)
      bitBuffer = bitBuffer >> 8
      numberOfBits = numberOfBits - 8
    }

    const oldOutBits = this.outBits
    const mask8 = 0xff

    this.outputBufferView[this.outputBufferSize - 1] =
      this.outputBufferView[this.outputBufferSize - 1] | ((bitBuffer << oldOutBits) & mask8)

    this.outBits = this.outBits + numberOfBits

    if (this.outBits > 8) {
      this.outBits = this.outBits & 7
      bitBuffer = bitBuffer >> (8 - oldOutBits)
      this.outputBufferView[this.outputBufferSize] = bitBuffer & mask8
      this.outputBufferSize = this.outputBufferSize + 1
    } else {
      this.outBits = this.outBits & 7
      if (this.outBits === 0) {
        this.outputBufferView[this.outputBufferSize] = 0
        this.outputBufferSize = this.outputBufferSize + 1
      }
    }
  }
}
