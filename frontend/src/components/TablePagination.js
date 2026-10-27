import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Footer pagination for the Access Management tables. Purely presentational —
 * the parent owns `page` / `pageSize` and slices its own rows.
 */
const TablePagination = ({
    page,
    pageSize,
    totalItems,
    onPageChange,
    onPageSizeChange,
    pageSizeOptions = [10, 25, 50, 100],
    label = 'items'
}) => {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const from = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, totalItems);

    // Windowed page numbers so a long list doesn't spill a hundred buttons.
    const pageNumbers = [];
    const windowStart = Math.max(1, Math.min(page - 2, totalPages - 4));
    const windowEnd = Math.min(totalPages, windowStart + 4);
    for (let i = windowStart; i <= windowEnd; i += 1) pageNumbers.push(i);

    return (
        <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    Showing <span className="font-medium text-gray-700 dark:text-gray-200">{from}-{to}</span> of{' '}
                    <span className="font-medium text-gray-700 dark:text-gray-200">{totalItems}</span> {label}
                </p>
                {onPageSizeChange && (
                    <select
                        value={pageSize}
                        onChange={(e) => onPageSizeChange(Number(e.target.value))}
                        className="px-2 py-1 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md text-xs text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
                    >
                        {pageSizeOptions.map(size => (
                            <option key={size} value={size}>{size} / page</option>
                        ))}
                    </select>
                )}
            </div>

            <div className="flex items-center gap-1">
                <button
                    onClick={() => onPageChange(page - 1)}
                    disabled={page <= 1}
                    className="p-1.5 border border-gray-300 dark:border-slate-600 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Previous page"
                >
                    <ChevronLeft size={16} />
                </button>
                {pageNumbers.map(num => (
                    <button
                        key={num}
                        onClick={() => onPageChange(num)}
                        className={`min-w-[32px] px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${num === page
                            ? 'bg-indigo-600 text-white'
                            : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800'
                            }`}
                    >
                        {num}
                    </button>
                ))}
                <button
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages}
                    className="p-1.5 border border-gray-300 dark:border-slate-600 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Next page"
                >
                    <ChevronRight size={16} />
                </button>
            </div>
        </div>
    );
};

export default TablePagination;
