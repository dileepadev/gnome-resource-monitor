// SPDX-License-Identifier: MIT
// Pure in-memory history of panel readings for the menu graphs.

export class Series {
    constructor(capacity = 3600) {
        this._values = new Array(capacity).fill(null);
        this._next = 0;
        this._capacity = capacity;
    }

    push(value) {
        this._values[this._next] = Number.isFinite(value) ? value : null;
        this._next = (this._next + 1) % this._capacity;
    }

    /** The last `count` values, oldest first (null where nothing was recorded). */
    last(count) {
        const length = Math.min(count, this._capacity);
        const result = new Array(length);
        for (let index = 0; index < length; index++)
            result[index] = this._values[(this._next - length + index + this._capacity) % this._capacity];
        return result;
    }
}

/** Average values into `buckets` points, keeping gaps (all-null buckets) as null. */
export function downsample(values, buckets) {
    if (buckets <= 0)
        return [];
    const result = [];
    for (let bucket = 0; bucket < buckets; bucket++) {
        const from = Math.floor(bucket * values.length / buckets);
        const to = Math.max(from + 1, Math.floor((bucket + 1) * values.length / buckets));
        let sum = 0;
        let count = 0;
        for (let index = from; index < to && index < values.length; index++) {
            if (values[index] !== null) {
                sum += values[index];
                count++;
            }
        }
        result.push(count ? sum / count : null);
    }
    return result;
}

/**
 * A readable axis maximum in binary units: 1, 2, 5, 10, 20, 50, 100, 200, or
 500 × 1024^n (so the label reads "2.00 MiB/s", not "977 KiB/s").
 */
export function niceMax(values, minimum = 1024) {
    const max = Math.max(minimum, ...values.filter(value => value !== null));
    const unit = 1024 ** Math.floor(Math.log(max) / Math.log(1024));
    for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
        if (step * unit >= max)
            return step * unit;
    }
    return 1024 * unit;
}
