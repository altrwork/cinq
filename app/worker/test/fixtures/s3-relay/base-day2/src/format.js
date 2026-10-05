export function formatMoney(amount, options = {}) {
  const symbol = options?.symbol ?? '$';
  const fixed = Math.abs(amount).toFixed(2);
  const sign = amount < 0 && Number(fixed) !== 0 ? '-' : '';
  const [whole, frac] = fixed.split('.');
  return sign + symbol + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
}
