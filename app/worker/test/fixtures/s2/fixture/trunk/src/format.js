export function formatMoney(amount) {
  const [whole, frac] = amount.toFixed(2).split('.');
  return '$' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
}
