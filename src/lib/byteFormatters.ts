// Author: Liz
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

type ByteUnit = (typeof BYTE_UNITS)[number];

interface FormatBytesOptions {
  emptyLabel?: string;
  maxUnit?: ByteUnit;
}

export function formatBytes(value?: number | null, options: FormatBytesOptions = {}) {
  const emptyLabel = options.emptyLabel ?? "-";
  if (value == null || Number.isNaN(value)) return emptyLabel;

  const maxUnitIndex = options.maxUnit ? BYTE_UNITS.indexOf(options.maxUnit) : BYTE_UNITS.length - 1;
  const lastUnitIndex = maxUnitIndex >= 0 ? maxUnitIndex : BYTE_UNITS.length - 1;
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < lastUnitIndex) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${BYTE_UNITS[index]}`;
}
