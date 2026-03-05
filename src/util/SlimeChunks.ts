const MULT = 0x5DEECE66Dn
const ADD = 0xBn
const MASK = (1n << 48n) - 1n

// 2^31 - (2^31 % 10) = 2147483640, used by Java Random.nextInt(10) rejection sampling
const NEXT_INT_10_THRESHOLD = 2147483640

function next31(state: { seed48: bigint }): number {
	state.seed48 = (state.seed48 * MULT + ADD) & MASK
	return Number(state.seed48 >> 17n) // 48 - 31 = 17
}

function javaNextInt10(state: { seed48: bigint }): number {
	while (true) {
		const bits = next31(state)
		if (bits < NEXT_INT_10_THRESHOLD) return bits % 10
	}
}

/**
 * Java Edition slime chunk predicate:
 * new Random(seedMix).nextInt(10) == 0
 *
 * 注意：chunkX/chunkZ 的中间计算有 int(32-bit) 溢出语义；这里显式模拟。
 */
export function isSlimeChunk(worldSeed: bigint, chunkX: number, chunkZ: number): boolean {
	const x = BigInt(chunkX)
	const z = BigInt(chunkZ)

	// int32 overflow for the int multiplications
	const t1 = BigInt.asIntN(64, BigInt.asIntN(32, x * x * 4987142n))
	const t2 = BigInt.asIntN(64, BigInt.asIntN(32, x * 5947611n))

	const zz32 = BigInt.asIntN(32, z * z) // (int)(z*z)
	const t3 = BigInt.asIntN(64, BigInt(zz32) * 4392871n) // then * 4392871L
	const t4 = BigInt.asIntN(64, BigInt.asIntN(32, z * 389711n))

	let mixed = BigInt.asIntN(64, worldSeed + t1 + t2 + t3 + t4)
	mixed = BigInt.asIntN(64, mixed ^ 987234911n)

	// java.util.Random seed init: (seed ^ MULT) & MASK
	const state = { seed48: (mixed ^ MULT) & MASK }
	return javaNextInt10(state) === 0
}
