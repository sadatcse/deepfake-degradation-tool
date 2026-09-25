'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Dices, RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { DegradationId, Severity } from '@/types';
import { SEVERITIES } from '@/types';
import { DEGRADATIONS, getDegradation } from '@/lib/degradations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface Props {
  selected: DegradationId[];
  tiers: Severity[];
  levels: Record<string, string[]>;
  customised: DegradationId[];
  includeCombined: boolean;
  combinedOrder: DegradationId[];
  randomMode: boolean;
  randomSets: number;
  randomSeed: number;
  disabled: boolean;
  onToggleDegradation: (id: DegradationId) => void;
  onToggleTier: (tier: Severity) => void;
  onSetLevels: (id: DegradationId, levelIds: string[]) => void;
  onResetLevels: (id: DegradationId) => void;
  onToggleCombined: (value: boolean) => void;
  onMoveInOrder: (id: DegradationId, direction: -1 | 1) => void;
  onChangeRandom: (patch: { randomMode?: boolean; randomSets?: number; randomSeed?: number }) => void;
}

/**
 * Degradation selection (spec 6), severity tiers (spec 39) and the exact
 * parameters each choice resolves to.
 *
 * Every selected degradation shows its real settings up front - "CRF 34",
 * "sigma 3.33", "short side 480px" - so nothing is a surprise once several
 * thousand encodes are under way.
 */
export function DegradationPanel({
  selected,
  tiers,
  levels,
  customised,
  includeCombined,
  combinedOrder,
  randomMode,
  randomSets,
  randomSeed,
  disabled,
  onToggleDegradation,
  onToggleTier,
  onSetLevels,
  onResetLevels,
  onToggleCombined,
  onMoveInOrder,
  onChangeRandom,
}: Props) {
  const [expanded, setExpanded] = useState<DegradationId | null>(null);

  const orderedSelection = combinedOrder.filter((id) => selected.includes(id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          Degradations
        </CardTitle>
        <CardDescription>
          Pick the degradations to apply and the severity tiers to run. Every output is written to
          its own folder; the originals are never touched.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">Severity</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {SEVERITIES.map((tier) => (
              <Button
                key={tier}
                type="button"
                variant={tiers.includes(tier) ? 'default' : 'outline'}
                size="sm"
                disabled={disabled}
                onClick={() => onToggleTier(tier)}
                className="capitalize"
              >
                {tier}
              </Button>
            ))}
            <span className="self-center text-xs text-muted-foreground">
              {tiers.length === 0
                ? 'Select at least one tier'
                : randomMode
                  ? `${tiers.length} tier${tiers.length === 1 ? '' : 's'} - each random output draws one of these`
                  : `${tiers.length} tier${tiers.length === 1 ? '' : 's'} - each selected degradation runs once per tier`}
            </span>
          </div>
        </div>

        <Separator />

        <div className="grid gap-2 lg:grid-cols-2">
          {DEGRADATIONS.map((definition) => {
            const id = definition.id as DegradationId;
            const isSelected = selected.includes(id);
            const activeLevels = levels[id] ?? [];
            const isCustom = customised.includes(id);
            const isExpanded = expanded === id;

            return (
              <div
                key={id}
                className={cn(
                  'rounded-lg border px-3 py-2.5 transition-colors',
                  isSelected ? 'border-primary/50 bg-accent/30' : 'border-border',
                )}
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={`deg-${id}`}
                    checked={isSelected}
                    disabled={disabled}
                    onCheckedChange={() => onToggleDegradation(id)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`deg-${id}`} className="cursor-pointer text-sm">
                      {definition.label}
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">{definition.description}</p>

                    {isSelected ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {activeLevels.length === 0 ? (
                          <Badge variant="destructive">no level selected</Badge>
                        ) : (
                          activeLevels.map((levelId) => {
                            const level = definition.levels.find((l) => l.id === levelId);
                            return (
                              <Badge key={levelId} variant="secondary" className="font-mono">
                                {level ? `${level.label}: ${level.summary}` : levelId}
                              </Badge>
                            );
                          })
                        )}
                        {isCustom ? <Badge variant="warning">custom</Badge> : null}
                      </div>
                    ) : null}
                  </div>

                  {isSelected ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      disabled={disabled}
                      onClick={() => setExpanded(isExpanded ? null : id)}
                      aria-label="Choose exact levels"
                    >
                      <SlidersHorizontal />
                    </Button>
                  ) : null}
                </div>

                {isSelected && isExpanded ? (
                  <div className="mt-3 rounded-md border border-border bg-card p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Levels to run
                      </p>
                      {isCustom ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => onResetLevels(id)}
                        >
                          <RotateCcw />
                          Follow severity
                        </Button>
                      ) : null}
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {definition.levels.map((level) => {
                        const checked = activeLevels.includes(level.id);
                        return (
                          <label
                            key={level.id}
                            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                          >
                            <Checkbox
                              checked={checked}
                              disabled={disabled}
                              onCheckedChange={() => {
                                const next = checked
                                  ? activeLevels.filter((l) => l !== level.id)
                                  : [...activeLevels, level.id];
                                // Keep catalogue order so filenames sort predictably.
                                onSetLevels(
                                  id,
                                  definition.levels
                                    .filter((l) => next.includes(l.id))
                                    .map((l) => l.id),
                                );
                              }}
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-xs font-medium">
                                {level.label}
                                {level.tier ? (
                                  <span className="ml-1.5 text-muted-foreground">
                                    ({level.tier})
                                  </span>
                                ) : null}
                              </span>
                              <span className="block font-mono text-[11px] text-muted-foreground">
                                {level.summary}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="random-mode" className="flex items-center gap-1.5 text-sm">
                <Dices className="size-4 text-muted-foreground" />
                Random mode
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Instead of every combination, give each video a set number of outputs, each with one
                degradation and one severity picked at random from the selection above. Written to
                random/set_1, random/set_2, ...
              </p>
            </div>
            <Switch
              id="random-mode"
              checked={randomMode}
              disabled={disabled}
              onCheckedChange={(value) => onChangeRandom({ randomMode: value })}
            />
          </div>

          {randomMode ? (
            <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="random-sets" className="text-xs">
                  Random sets per video
                </Label>
                <Input
                  id="random-sets"
                  type="number"
                  min={1}
                  max={20}
                  value={randomSets}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value));
                    if (Number.isFinite(value)) {
                      onChangeRandom({ randomSets: Math.min(20, Math.max(1, value)) });
                    }
                  }}
                  className="mt-1"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Each video gets {randomSets} degraded output{randomSets === 1 ? '' : 's'}
                </p>
              </div>
              <div>
                <Label htmlFor="random-seed" className="text-xs">
                  Seed
                </Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    id="random-seed"
                    type="number"
                    min={0}
                    value={randomSeed}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = Math.round(Number(event.target.value));
                      if (Number.isFinite(value) && value >= 0 && value <= 2_147_483_647) {
                        onChangeRandom({ randomSeed: value });
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={disabled}
                    onClick={() =>
                      onChangeRandom({ randomSeed: Math.floor(Math.random() * 2_147_483_647) })
                    }
                    aria-label="New random seed"
                  >
                    <Dices />
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Same seed = same picks, so a resumed run stays consistent.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {randomMode ? null : (
          <>
            <Separator />

            <div className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label htmlFor="combined" className="text-sm">
                    Combined degradation
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Chain every selected degradation into one extra output per severity, encoded in a
                    single pass. Needs at least two degradations.
                  </p>
                </div>
                <Switch
                  id="combined"
                  checked={includeCombined}
                  disabled={disabled || orderedSelection.length < 2}
                  onCheckedChange={onToggleCombined}
                />
              </div>

              {includeCombined && orderedSelection.length >= 2 ? (
                <div className="rounded-lg border border-border p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Pipeline order
                  </p>
                  <div className="mb-3 flex flex-wrap items-center gap-1.5 font-mono text-xs">
                    {orderedSelection.map((id, index) => (
                      <span key={id} className="flex items-center gap-1.5">
                        {index > 0 ? <span className="text-muted-foreground">-&gt;</span> : null}
                        <Badge variant="outline">{getDegradation(id).label}</Badge>
                      </span>
                    ))}
                  </div>
                  <div className="space-y-1">
                    {orderedSelection.map((id, index) => (
                      <div
                        key={id}
                        className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
                      >
                        <span className="w-5 text-center font-mono text-xs text-muted-foreground">
                          {index + 1}
                        </span>
                        <span className="flex-1 text-sm">{getDegradation(id).label}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={disabled || index === 0}
                          onClick={() => onMoveInOrder(id, -1)}
                          aria-label="Move earlier in the pipeline"
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={disabled || index === orderedSelection.length - 1}
                          onClick={() => onMoveInOrder(id, 1)}
                          aria-label="Move later in the pipeline"
                        >
                          <ArrowDown />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
