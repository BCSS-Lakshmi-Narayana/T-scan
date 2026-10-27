import * as XLSX from 'xlsx';

// Widen each column to fit its longest cell so the sheet is readable without
// dragging borders. Capped so a stray user-agent string doesn't blow the layout.
const autoColumnWidths = (rows) => {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]).map((key) => {
        const longest = rows.reduce((max, row) => {
            const len = String(row[key] ?? '').length;
            return len > max ? len : max;
        }, key.length);
        return { wch: Math.min(Math.max(longest + 2, 10), 50) };
    });
};

/**
 * Write an array of flat objects to an .xlsx download. Object keys become the
 * header row, so build the rows in the order the columns should appear.
 */
export const exportRowsToExcel = ({ rows, sheetName = 'Sheet1', fileName }) => {
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = autoColumnWidths(rows);

    const workbook = XLSX.utils.book_new();
    // Excel rejects sheet names over 31 chars or containing : \ / ? * [ ]
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.replace(/[:\\/?*[\]]/g, '').slice(0, 31));

    const stamp = new Date().toISOString().split('T')[0];
    XLSX.writeFile(workbook, `${fileName}_${stamp}.xlsx`);
};

export default exportRowsToExcel;
