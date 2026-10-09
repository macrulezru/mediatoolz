<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { formatBytes, imageUrl } from '../../api'
import { NAVIGATE } from './nav'
import type { BatchReport, BatchResult, JobStatus } from './types'

const props = defineProps<{ report: BatchReport }>()
const navigate = inject(NAVIGATE, () => undefined)

function openBackup(): void {
  try {
    if (props.report.backupDir)
      localStorage.setItem('mediatoolz-ui.open-backup', props.report.backupDir)
  } catch {
    navigate('backups')
    return
  }
  navigate('backups')
}

const PAGE = 30
const shown = ref(PAGE)

const LABELS: Record<JobStatus, string> = {
  written: 'written',
  'up-to-date': 'up to date',
  skipped: 'skipped',
  conflict: 'conflict',
  'would-write': 'would write',
  'would-overwrite': 'would overwrite',
  replaced: 'replaced',
  kept: 'kept original',
  'already-processed': 'already processed',
  'would-replace': 'would replace',
  'would-keep': 'would keep',
  error: 'error',
}

const GOOD = new Set<JobStatus>(['written', 'replaced', 'up-to-date'])
const BAD = new Set<JobStatus>(['error', 'conflict'])
const HAS_OUTPUT = new Set<JobStatus>(['written', 'replaced', 'up-to-date', 'skipped', 'kept'])

const counts = computed(() =>
  (Object.entries(props.report.counts) as [JobStatus, number][]).filter(([, count]) => count > 0),
)
const saved = computed(() => {
  const { bytesIn, bytesOut } = props.report
  if (props.report.dryRun || bytesIn <= 0 || bytesOut <= 0) return undefined
  return { bytes: bytesIn - bytesOut, percent: Math.round((1 - bytesOut / bytesIn) * 100) }
})
const rows = computed(() => props.report.results.slice(0, shown.value))

function tone(status: JobStatus): string {
  if (GOOD.has(status)) return 'good'
  if (BAD.has(status)) return 'bad'
  return 'neutral'
}

function delta(row: BatchResult): string {
  if (row.before === undefined || row.bytes === undefined || row.before <= 0) return ''
  const change = Math.round((row.bytes / row.before - 1) * 100)
  return `${change > 0 ? '+' : ''}${change}%`
}

function showsOutput(row: BatchResult): boolean {
  return !props.report.dryRun && HAS_OUTPUT.has(row.status) && row.status !== 'skipped'
}
</script>

<template>
  <section class="card block">
    <div class="head">
      <h2>{{ report.dryRun ? 'Plan' : 'Result' }}</h2>
      <span class="muted">
        {{ report.results.length }} file{{ report.results.length === 1 ? '' : 's' }}
        <template v-if="report.configLabel"> · config {{ report.configLabel }}</template>
      </span>
    </div>

    <div class="chips">
      <span
        v-for="[status, count] in counts"
        :key="status"
        class="chip"
        :class="`chip--${tone(status)}`"
      >
        {{ count }} {{ LABELS[status] }}
      </span>
      <span v-if="report.deduped" class="chip">{{ report.deduped }} merged (same result)</span>
      <span v-if="saved" class="chip chip--good">
        saved {{ formatBytes(Math.max(saved.bytes, 0)) }}
        <template v-if="saved.percent > 0">(−{{ saved.percent }}%)</template>
      </span>
    </div>

    <p v-if="report.dryRun" class="notice">
      This is a preview: nothing was written. Press “Convert” to do it.
    </p>
    <p v-if="report.backupDir && !report.dryRun" class="notice">
      Originals were copied to <code>{{ report.backupDir }}</code> first.
      <button class="link" @click="openBackup">View or restore this backup</button>
    </p>
    <p v-if="report.derived.length" class="muted small">
      {{ report.derived.length }} earlier result{{
        report.derived.length === 1 ? ' was' : 's were'
      }}
      not treated as sources.
    </p>
    <p v-if="report.vectors.length" class="muted small">
      {{ report.vectors.length }} SVG file{{ report.vectors.length === 1 ? ' was' : 's were' }} left
      out of the replacement.
    </p>

    <ul v-if="report.failures.length" class="errors">
      <li v-for="failure in report.failures" :key="failure.file">
        <code>{{ failure.file }}</code> — {{ failure.message }}
      </li>
    </ul>

    <ul class="rows">
      <li v-for="row in rows" :key="`${row.sourceAbs}|${row.outputAbs}|${row.recipe}`" class="row">
        <img class="row__thumb" loading="lazy" alt="" :src="imageUrl(row.sourceAbs, 120)" />
        <span class="row__arrow muted">→</span>
        <img
          v-if="showsOutput(row)"
          class="row__thumb"
          loading="lazy"
          alt=""
          :src="imageUrl(row.outputAbs, 120)"
        />
        <span v-else class="row__thumb row__thumb--empty muted">{{
          report.dryRun ? 'plan' : '—'
        }}</span>
        <div class="row__text">
          <span class="row__name" :title="row.outputAbs">{{ row.output }}</span>
          <span class="muted small">
            from {{ row.source }} · {{ row.width }}×{{ row.height }} · {{ row.format }}
            <template v-if="row.recipe"> · {{ row.recipe }}</template>
          </span>
          <span v-if="row.message" class="small row__message">{{ row.message }}</span>
        </div>
        <div class="row__sizes">
          <span v-if="row.before !== undefined">{{ formatBytes(row.before) }}</span>
          <span v-if="row.before !== undefined && row.bytes !== undefined" class="muted">→</span>
          <strong v-if="row.bytes !== undefined">{{ formatBytes(row.bytes) }}</strong>
          <span
            v-if="delta(row)"
            class="row__delta"
            :class="{ 'row__delta--down': delta(row).startsWith('-') }"
            >{{ delta(row) }}</span
          >
        </div>
        <span class="chip" :class="`chip--${tone(row.status)}`">{{ LABELS[row.status] }}</span>
      </li>
    </ul>

    <div v-if="shown < report.results.length" class="more">
      <button class="btn" @click="shown += PAGE">
        Show more ({{ report.results.length - shown }} left)
      </button>
      <button class="btn" @click="shown = report.results.length">
        Show all ({{ report.results.length }})
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.block {
  @include stack($space-3);
  padding: 18px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
}

.small {
  font-size: $font-size-sm;
}

.chips {
  @include cluster;
}

.chip {
  padding: 2px 10px;
  border-radius: $radius-pill;
  background: var(--surface-2);
  font-size: $font-size-sm;
  white-space: nowrap;

  &--good {
    background: color-mix(in srgb, var(--ok) 18%, transparent);
    color: var(--ok);
  }

  &--bad {
    background: var(--danger-soft);
    color: var(--danger);
  }
}

.errors {
  margin: 0;
  padding: 10px 14px 10px 28px;
  border-radius: 10px;
  background: var(--danger-soft);
  color: var(--danger);
}

.rows {
  @include stack($space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-2;
  border: 1px solid var(--border);
  border-radius: $radius-md;

  &__thumb {
    flex: none;
    width: 64px;
    height: 64px;
    border-radius: $radius-sm;
    background: var(--surface-2);
    object-fit: cover;

    &--empty {
      @include grid-center;
      font-size: $font-size-xs;
    }
  }

  &__text {
    @include stack(2px);
    flex: 1;
    min-width: 0;
  }

  &__name {
    font-family: $font-mono;
    font-size: $font-size-sm;
    @include truncate;
  }

  &__message {
    color: var(--danger);
  }

  &__sizes {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex: none;
    font-size: $font-size-sm;
  }

  &__delta {
    color: var(--muted);

    &--down {
      color: var(--ok);
    }
  }

  @include respond-below(md) {
    flex-wrap: wrap;

    &__text {
      flex-basis: 60%;
    }
  }
}

.link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}

.more {
  @include cluster;
  justify-content: center;
}
</style>
