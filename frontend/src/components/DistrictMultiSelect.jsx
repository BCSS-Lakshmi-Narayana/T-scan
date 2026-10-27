import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

// Checkbox dropdown for picking multiple districts, with select-all/deselect-all.
// Styled to match the plain-Tailwind form inputs used in AccessManagement.js.
const DistrictMultiSelect = ({ options, value, onChange, disabled, placeholder = 'Select districts…' }) => {
    const [open, setOpen] = useState(false);
    const boxRef = useRef(null);

    useEffect(() => {
        const onClickOutside = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, []);

    const toggle = (d) => {
        onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d]);
    };
    const allSelected = options.length > 0 && value.length === options.length;

    const summary = value.length === 0 ? placeholder
        : value.length === options.length ? `All districts (${value.length})`
        : `${value.length} district${value.length > 1 ? 's' : ''} selected`;

    return (
        <div className="relative" ref={boxRef}>
            <button type="button" disabled={disabled}
                onClick={() => setOpen((o) => !o)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 flex items-center justify-between text-left disabled:opacity-50 disabled:cursor-not-allowed">
                <span className={value.length ? 'text-gray-800 dark:text-gray-200' : 'text-gray-400'}>{summary}</span>
                <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && !disabled && (
                <div className="absolute z-20 mt-1.5 w-full bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800">
                        <button type="button"
                            onClick={() => onChange(allSelected ? [] : options.slice())}
                            className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline">
                            {allSelected ? 'Deselect all' : 'Select all'}
                        </button>
                        <span className="text-[11px] text-gray-400 font-medium">{value.length}/{options.length}</span>
                    </div>
                    <div className="max-h-48 overflow-y-auto py-1">
                        {options.length === 0 && (
                            <p className="px-3 py-2 text-xs text-gray-400">No districts available.</p>
                        )}
                        {options.map((d) => (
                            <label key={d} className="flex items-center gap-2.5 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer">
                                <input type="checkbox" checked={value.includes(d)} onChange={() => toggle(d)}
                                    className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500/30" />
                                {d}
                            </label>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default DistrictMultiSelect;
