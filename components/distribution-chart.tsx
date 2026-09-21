'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CountBucket } from '@/types';

const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

interface Props {
  title: string;
  data: CountBucket[];
  /** Cap the number of bars so a long tail does not squash the chart. */
  limit?: number;
}

/** Horizontal bar chart used for the resolution / fps / codec breakdowns. */
export function DistributionChart({ title, data, limit = 6 }: Props) {
  const rows = data.slice(0, limit);
  const height = Math.max(96, rows.length * 26 + 16);

  if (rows.length === 0) {
    return (
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <p className="text-sm text-muted-foreground">No data.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 28, bottom: 0, left: 0 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={92}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          />
          <Tooltip
            cursor={{ fill: 'var(--accent)', opacity: 0.4 }}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--popover-foreground)',
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={14}>
            {rows.map((row, index) => (
              <Cell key={row.label} fill={PALETTE[index % PALETTE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
