export function parsePage(value: string | null, totalPages: number): number {
  if (totalPages < 1) {
    throw new RangeError("totalPages must be at least 1");
  }

  if (value === null) {
    return 1;
  }

  const page = Number(value);
  if (!Number.isInteger(page) || page < 1 || page > totalPages) {
    return 1;
  }

  return page;
}

export function getVisiblePages(currentPage: number, totalPages: number): number[] {
  if (currentPage < 1 || totalPages < 1 || currentPage > totalPages) {
    throw new RangeError("currentPage must be within totalPages");
  }

  const maximumVisiblePages = 10;
  if (totalPages <= maximumVisiblePages) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const preferredStart = currentPage - Math.floor(maximumVisiblePages / 2);
  const start = Math.min(
    Math.max(preferredStart, 1),
    totalPages - maximumVisiblePages + 1,
  );
  return Array.from({ length: maximumVisiblePages }, (_, index) => start + index);
}
