import * as d3 from 'd3';

(globalThis as typeof globalThis & { d3: typeof d3 }).d3 = d3;
