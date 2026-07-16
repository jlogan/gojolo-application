import { forwardRef, type InputHTMLAttributes } from 'react'
import { openNativeDatePicker } from '@/lib/dateInput'

export type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { onClick, onFocus, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type="date"
      {...props}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) openNativeDatePicker(e.currentTarget)
      }}
      onFocus={(e) => {
        onFocus?.(e)
        if (!e.defaultPrevented) openNativeDatePicker(e.currentTarget)
      }}
    />
  )
})

export default DateInput
