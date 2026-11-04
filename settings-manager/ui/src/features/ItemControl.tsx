import { Eye, EyeOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Item, Value } from '@/types'

/** The Select value that stands for an empty setting value. */
const EMPTY = '\u0000'

type Props = { item: Item; onSet: (value: Value | null) => void }

/** A text field that saves when it loses focus or when you press Enter. */
function TextField({ item, onSet, isHidden, className = 'w-56', placeholder = 'Default' }: Props & { isHidden?: boolean; className?: string; placeholder?: string }) {
  const commit = (value: string) => value !== String(item.value ?? '') && onSet(value)
  return (
    <Input
      key={String(item.value ?? '')}
      type={isHidden ? 'password' : 'text'}
      className={className}
      placeholder={placeholder}
      aria-label={item.title}
      defaultValue={String(item.value ?? '')}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

/** An environment variable: its value and a delete button. A secret value is hidden; an eye button inside the field shows it, on hover. */
function EnvControl({ item, onSet }: Props) {
  const [isShown, setIsShown] = useState(false)
  const label = isShown ? `Hide ${item.title}` : `Show ${item.title}`
  // A text field drops line breaks, so a value with several lines, such as a list of headers, gets a text area.
  // Hidden, it shows dots in a field that cannot be changed, so a blur never saves the value without its breaks.
  const text = String(item.value ?? '')
  const isMultiline = text.includes('\n')
  const isHidden = item.isSecret && !isShown
  const fieldClass = cn('w-72 font-mono text-[13px] md:text-[13px]', item.isSecret && 'pr-9')
  return (
    <>
      <div className="group relative">
        {!isMultiline ? (
          <TextField item={item} onSet={onSet} isHidden={isHidden} placeholder="Empty" className={fieldClass} />
        ) : isHidden ? (
          <Input readOnly type="password" value="multiline value" aria-label={item.title} className={fieldClass} />
        ) : (
          <Textarea
            key={text}
            rows={Math.min(6, text.split('\n').length)}
            defaultValue={text}
            aria-label={item.title}
            className={cn(fieldClass, 'min-h-0 resize-y')}
            onBlur={e => e.target.value !== text && onSet(e.target.value)}
          />
        )}
        {item.isSecret && (
          <button
            type="button"
            title={isShown ? 'Hide value' : 'Show value'}
            aria-label={label}
            onMouseDown={e => e.preventDefault()}
            onClick={() => setIsShown(!isShown)}
            className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-md text-muted-foreground opacity-0 transition-opacity outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 [&_svg]:size-4"
          >
            {isShown ? <EyeOff /> : <Eye />}
          </button>
        )}
      </div>
      <Button variant="ghost" size="icon" title="Delete" aria-label={`Delete ${item.title}`} className="text-muted-foreground hover:text-destructive" onClick={() => onSet(null)}>
        <Trash2 />
      </Button>
    </>
  )
}

/** The control for one row: a switch, a segmented choice, a dropdown, a text field or a variable. */
export function ItemControl({ item, onSet }: Props) {
  const control = item.control ?? 'switch'
  const set = (value: Value) => onSet(value)

  if (control === 'env') return <EnvControl item={item} onSet={onSet} />

  if (control === 'switch') return <Switch checked={!!item.value} disabled={item.isDisabled} aria-label={item.title} onCheckedChange={set} className="data-[state=checked]:bg-[#4cc2ff] data-[state=checked]:hover:bg-[#47b1e8]" />

  if (control === 'segmented')
    return (
      <ToggleGroup type="single" variant="outline" disabled={item.isDisabled} value={String(item.value ?? '') || EMPTY} onValueChange={value => value && set(value === EMPTY ? '' : value)}>
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
      <Select disabled={item.isDisabled} value={current || EMPTY} onValueChange={value => set(value === EMPTY ? '' : value)}>
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

  return <TextField item={item} onSet={onSet} />
}
