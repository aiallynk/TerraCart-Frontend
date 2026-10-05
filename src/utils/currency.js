const INR_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Keep the symbol encoded independently of source-file encoding. Displayed
// currency should always be produced by formatINR rather than concatenated.
export const INR_CURRENCY_SYMBOL = "\u20B9";

export const formatINR = (value) => {
  const amount = Number(value);
  return INR_FORMATTER.format(Number.isFinite(amount) ? amount : 0);
};
