type Flat<T> = { [K in keyof T]: T[K] };

/** True only when both types have exactly the same fields, each of exactly the same type. */
export type SameShape<A, B> = (<T>(probe?: T) => T extends Flat<A> ? 1 : 2) extends <T>(probe?: T) => T extends Flat<B> ? 1 : 2 ? true : false;

/** Fails to compile unless its argument is `true`. */
export type Expect<T extends true> = T;
