import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";

type OutputFilenameFieldProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  defaultName: string;
  placeholder: string;
  disabled?: boolean;
  extension?: "pdf" | "jpg" | "png" | "zip";
};

export default function OutputFilenameField({
  id,
  value,
  onChange,
  defaultName,
  placeholder,
  disabled = false,
  extension = "pdf",
}: OutputFilenameFieldProps) {
  return (
    <TextField
      id={id}
      className="filename-field"
      label="輸出檔名"
      variant="outlined"
      fullWidth
      value={value.replace(new RegExp(`\\.${extension}$`, "i"), "")}
      onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => {
        if (!event.currentTarget.value.trim()) onChange(defaultName);
      }}
      placeholder={placeholder}
      disabled={disabled}
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end" disableTypography>
              .{extension}
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
