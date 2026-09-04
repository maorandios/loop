type FileNameProps = {
  name: string;
  className?: string;
};

export function FileName({ name, className = "" }: FileNameProps) {
  return (
    <span
      dir="auto"
      title={name}
      className={`inline-block max-w-full truncate align-bottom text-start ${className}`.trim()}
    >
      {name}
    </span>
  );
}
