mod constants;

use constants::*;
use std::cmp;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn implode_binary_large(input: &[u8]) -> Vec<u8> {
    implode_inner(input, 0, 6) // binary=0 for header, large=6
}

fn implode_inner(input: &[u8], ctype: u8, dsize: u8) -> Vec<u8> {
    let input_len = input.len();
    if input_len == 0 {
        return vec![ctype, dsize, 0];
    }

    let block_size = match dsize {
        4 => 0x400,
        5 => 0x800,
        _ => 0x1000,
    };
    let dsize_mask = (1 << dsize) - 1;

    let mut n_ch_bits = [0u16; 0x306];
    let mut n_ch_codes = [0u16; 0x306];

    setup_tables_binary(&mut n_ch_bits, &mut n_ch_codes);

    let mut output = Vec::with_capacity(input_len + SIZE_OF_HEADER + MAX_SIZE_OF_TERMINATION_LITERAL);
    output.push(ctype);
    output.push(dsize);
    output.push(0);

    let mut out_bits: u8 = 0;
    let mut out_size = 3;

    if input_len <= 2 {
        for byte in input {
            output_bits(
                &mut output,
                &mut out_size,
                &mut out_bits,
                n_ch_bits[*byte as usize] as u8,
                n_ch_codes[*byte as usize] as u32,
            );
        }
        output_bits(
            &mut output,
            &mut out_size,
            &mut out_bits,
            n_ch_bits[LITERAL_END_STREAM] as u8,
            n_ch_codes[LITERAL_END_STREAM] as u32,
        );
        return output;
    }

    let mut hash_table = vec![-1i32; HASH_TABLE_SIZE];
    let mut input_start = 0;
    let mut view = input;

    output_bits(
        &mut output,
        &mut out_size,
        &mut out_bits,
        n_ch_bits[view[0] as usize] as u8,
        n_ch_codes[view[0] as usize] as u32,
    );
    output_bits(
        &mut output,
        &mut out_size,
        &mut out_bits,
        n_ch_bits[view[1] as usize] as u8,
        n_ch_codes[view[1] as usize] as u32,
    );
    input_start = 2;

    let hash = ((view[0] as u32) << 8) | view[1] as u32;
    hash_table[hash as usize] = 0;
    if view.len() > 2 {
        let hash2 = ((view[1] as u32) << 8) | view[2] as u32;
        hash_table[hash2 as usize] = 1;
    }

    while view.len() > input_start {
        let cursor = input_start;
        let (size, distance) = find_repetition(view, &mut hash_table, cursor);

        let remaining = view.len() - input_start;
        let is_flushable = is_repetition_flushable(size, distance, remaining);

        if !is_flushable {
            let byte = view[input_start];
            output_bits(
                &mut output,
                &mut out_size,
                &mut out_bits,
                n_ch_bits[byte as usize] as u8,
                n_ch_codes[byte as usize] as u32,
            );
            input_start += 1;
        } else {
            let byte = size + 0xfe;
            output_bits(
                &mut output,
                &mut out_size,
                &mut out_bits,
                n_ch_bits[byte as usize] as u8,
                n_ch_codes[byte as usize] as u32,
            );
            if size == 2 {
                let dist_byte = (distance >> 2) as usize;
                output_bits(
                    &mut output,
                    &mut out_size,
                    &mut out_bits,
                    DIST_BITS[dist_byte] as u8,
                    DIST_CODE[dist_byte] as u32,
                );
                output_bits(
                    &mut output,
                    &mut out_size,
                    &mut out_bits,
                    2,
                    distance & 3,
                );
            } else {
                let dist_byte = (distance >> 6) as usize;
                output_bits(
                    &mut output,
                    &mut out_size,
                    &mut out_bits,
                    DIST_BITS[dist_byte] as u8,
                    DIST_CODE[dist_byte] as u32,
                );
                output_bits(
                    &mut output,
                    &mut out_size,
                    &mut out_bits,
                    dsize as u8,
                    (distance & dsize_mask as u32),
                );
            }
            input_start += size;
        }

        if input_start >= block_size {
            view = &view[block_size..];
            input_start = 0;
            hash_table.fill(-1);
            if view.len() >= 2 {
                let h = ((view[0] as u32) << 8) | view[1] as u32;
                hash_table[h as usize] = 0;
            }
            if view.len() >= 3 {
                let h = ((view[1] as u32) << 8) | view[2] as u32;
                hash_table[h as usize] = 1;
            }
        }
    }

    output_bits(
        &mut output,
        &mut out_size,
        &mut out_bits,
        n_ch_bits[LITERAL_END_STREAM] as u8,
        n_ch_codes[LITERAL_END_STREAM] as u32,
    );

    output.truncate(out_size);
    output
}

fn setup_tables_binary(n_ch_bits: &mut [u16], n_ch_codes: &mut [u16]) {
    let mut n_ch_code: u16 = 0;
    for i in 0..0x100 {
        n_ch_bits[i] = 9;
        n_ch_codes[i] = n_ch_code;
        n_ch_code = ((n_ch_code & 0xFFFF) + 2) as u16;
    }

    let mut n_count = 0x100usize;
    for i in 0..16 {
        let ex_len = EX_LEN_BITS[i] as usize;
        for n_count2 in 0..(1 << ex_len) {
            n_ch_bits[n_count] = (EX_LEN_BITS[i] + LEN_BITS[i] + 1) as u16;
            n_ch_codes[n_count] =
                ((n_count2 << (LEN_BITS[i] + 1)) | ((LEN_CODE[i] as usize) * 2) | 1) as u16;
            n_count += 1;
        }
    }
}

fn get_size_of_matching(view: &[u8], index_a: usize, index_b: usize) -> usize {
    let distance = index_b - index_a;
    let max_safe = view.len().saturating_sub(index_b + 1);
    let limit = cmp::min(
        cmp::min(cmp::max(distance, 2), LONGEST_ALLOWED_REPETITION),
        max_safe,
    );

    if limit < 2 {
        return 2;
    }

    for i in 2..=limit {
        if view[index_a + i] != view[index_b + i] {
            return i;
        }
    }
    limit
}

fn find_repetition(
    view: &[u8],
    hash_table: &mut [i32],
    cursor: usize,
) -> (usize, u32) {
    if view.len() - cursor < 2 {
        return (0, 0);
    }

    let hash = ((view[cursor] as u32) << 8) | view[cursor + 1] as u32;
    let match_pos = hash_table[hash as usize];
    if match_pos < 0 {
        hash_table[hash as usize] = cursor as i32;
    }

    if match_pos >= 0 && cursor as i32 - match_pos >= 2 {
        let match_pos = match_pos as usize;
        let mut size = 2;
        if cursor - match_pos > 2 {
            size = get_size_of_matching(view, match_pos, cursor);
        }
        let distance_bytes = cursor - match_pos;
        return (size, (distance_bytes - 1) as u32);
    }

    (0, 0)
}

fn is_repetition_flushable(size: usize, distance: u32, remaining: usize) -> bool {
    if size == 0 {
        return false;
    }
    if size == 2 && distance >= 0x100 {
        return false;
    }
    if size >= 8 || remaining < 2 {
        return true;
    }
    false
}

fn output_bits(
    output: &mut Vec<u8>,
    out_size: &mut usize,
    out_bits: &mut u8,
    mut num_bits: u8,
    mut bit_buffer: u32,
) {
    while num_bits > 8 {
        output_bits_inner(output, out_size, out_bits, 8, bit_buffer);
        bit_buffer >>= 8;
        num_bits -= 8;
    }
    output_bits_inner(output, out_size, out_bits, num_bits, bit_buffer);
}

fn output_bits_inner(
    output: &mut Vec<u8>,
    out_size: &mut usize,
    out_bits: &mut u8,
    num_bits: u8,
    bit_buffer: u32,
) {
    while output.len() <= *out_size {
        output.push(0);
    }

    let old_out_bits = *out_bits;
    let mask8 = 0xffu32;

    output[*out_size - 1] =
        (output[*out_size - 1] as u32 | ((bit_buffer << old_out_bits) & mask8)) as u8;

    *out_bits += num_bits;

    if *out_bits > 8 {
        *out_bits &= 7;
        let shifted = bit_buffer >> (8 - old_out_bits);
        output.push((shifted & mask8) as u8);
        *out_size += 1;
    } else {
        *out_bits &= 7;
        if *out_bits == 0 {
            output.push(0);
            *out_size += 1;
        }
    }
}
