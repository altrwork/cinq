import { total } from './cart.js';

export function shipping(items) {
  return total(items) >= 50 ? 0 : 4.99;
}
