import type { Style } from '../../format/style.js'
import { askText, promptChoice, singleSelect, type SelectItem } from '../../utils/tty.js'
import type { ManageEnv } from './manage.js'
import {
  SHARPEN_AMOUNTS,
  SHARPEN_FINE_KEYS,
  SHARPEN_RANGES,
  SHARPEN_TARGETS,
  type SharpenFields,
  type SharpenFineKey,
  type SharpenTarget,
} from './sharpen.js'

type AskEnv = Pick<ManageEnv, 'io' | 'log'>

export async function askSharpenFields(
  env: AskEnv,
  s: Style,
  current: SharpenFields = {},
): Promise<SharpenFields | null> {
  const target = await singleSelect(
    env.io,
    SHARPEN_TARGETS.map((value) => ({
      label: value,
      hint:
        value === 'screen'
          ? 'light, for the web and displays'
          : value === 'matte'
            ? 'medium, for matte paper'
            : 'strong, for glossy paper',
      value,
    })) as SelectItem<SharpenTarget>[],
    { title: 'Sharpen for', help: 'enter pick · q cancel' },
    s,
  )
  if (target === null) return null
  const amount = await singleSelect(
    env.io,
    SHARPEN_AMOUNTS.map((value) => ({
      label: value,
      hint: value === 'standard' ? 'recommended' : '',
      value,
    })),
    { title: 'Sharpening amount', help: 'enter pick · q cancel' },
    s,
  )
  if (amount === null) return null
  const fields: SharpenFields = { for: target, amount }
  const fine = await promptChoice(
    env.io,
    'Fine-tune radius, flat, jagged and threshold?',
    [
      { key: 'y', label: 'yes' },
      { key: 'n', label: 'no' },
    ],
    s,
    'n',
  )
  if (fine !== 'y') return fields
  for (const key of SHARPEN_FINE_KEYS) {
    const value = await askFine(env, s, key, current[key])
    if (value === null) return null
    if (value !== undefined) fields[key] = value
  }
  return fields
}

async function askFine(
  env: AskEnv,
  s: Style,
  key: SharpenFineKey,
  current: number | undefined,
): Promise<number | undefined | null> {
  const [min, max] = SHARPEN_RANGES[key]
  for (;;) {
    const answer = await askText(
      env.io,
      `${key} (${min}–${max}; empty = the table value):`,
      s,
      current === undefined ? '' : String(current),
    )
    if (answer === null) return null
    const text = answer.trim()
    if (text === '') return undefined
    const number = Number(text)
    if (Number.isFinite(number) && number >= min && number <= max) return number
    env.log(s.warn(`${key}: expected a number from ${min} to ${max}.`))
  }
}
