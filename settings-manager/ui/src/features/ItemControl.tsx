import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Act, Item, Value } from '@/types'

/** The Select value that stands for an empty setting value. */
const EMPTY = '\u0000'

type Props = { item: Item; onAct: (action: Act, value: Value) => void }

/** The control for one row: a switch, a segmented choice, a dropdown, or a text field. */
export function ItemControl({ item, onAct }: Props) {
  const control = item.control ?? 'switch'
  const set = (value: Value) => onAct(item.act, value)

  if (control === 'switch') return <Switch checked={!!item.value} aria-label={item.title} onCheckedChange={set} className="data-[state=checked]:bg-[#4cc2ff] data-[state=checked]:hover:bg-[#47b1e8]" />

  if (control === 'segmented')
    return (
      <ToggleGroup type="single" variant="outline" value={String(item.value ?? '') || EMPTY} onValueChange={value => value && set(value === EMPTY ? '' : value)}>
        {item.options?.map(option => (
          <ToggleGroupItem key={option.value} value={option.value || EMPTY} className="px-3">
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    )

  if (control === 'select') {
    const current = String(item.value ?? '')
    const options = item.options?.some(option => option.value === current) ? item.options : [...(item.options ?? []), { value: current, label: current }]
    return (
      <Select value={current || EMPTY} onValueChange={value => set(value === EMPTY ? '' : value)}>
        <SelectTrigger className="w-56" aria-label={item.title}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value || EMPTY}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  const commit = (value: string) => value !== String(item.value ?? '') && set(value)
  return (
    <Input
      key={String(item.value ?? '')}
      className="w-56"
      placeholder="Default"
      aria-label={item.title}
      defaultValue={String(item.value ?? '')}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}
