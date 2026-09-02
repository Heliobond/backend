import { calculateScore } from '../lib/scoring-formula';
test('happy', () => expect(calculateScore({a:1},{a:2})).toBe(2));
test('edge', () => expect(() => calculateScore({a:0},{a:2})).toThrow());