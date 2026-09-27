import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect } from "react";

import { formatBytes } from "../files/file";

import "./Counter.css";

type CounterProps = {
  value: number;
  fractionDigits?: number;
  minimumIntegerDigits?: number;
};

type DigitProps = {
  value: number;
  place: number;
};

function NumberAtPosition({
  position,
  spring,
}: {
  position: number;
  spring: MotionValue<number>;
}) {
  const y = useTransform(spring, (latest) => {
    const currentDigit = latest % 10;
    const offset = (10 + position - currentDigit) % 10;
    return `${(offset > 5 ? offset - 10 : offset) * 100}%`;
  });

  return (
    <motion.span className="rolling-counter-number" style={{ y }}>
      {position}
    </motion.span>
  );
}

function Digit({ value, place }: DigitProps) {
  const scaled = value / place;
  const nearest = Math.round(scaled);
  const rounded =
    Math.abs(scaled - nearest) < 1e-9 * Math.max(1, Math.abs(scaled))
      ? nearest
      : scaled;
  const target = Math.floor(rounded);
  const spring = useSpring(0, { stiffness: 160, damping: 26 });

  useEffect(() => {
    spring.set(target);
  }, [spring, target]);

  return (
    <span className="rolling-counter-digit">
      {Array.from({ length: 10 }, (_, position) => (
        <NumberAtPosition key={position} position={position} spring={spring} />
      ))}
    </span>
  );
}

export default function Counter({
  value,
  fractionDigits = 0,
  minimumIntegerDigits = 1,
}: CounterProps) {
  const reduceMotion = useReducedMotion();
  const [integer, decimal] = value.toFixed(fractionDigits).split(".");
  const formatted = `${integer.padStart(minimumIntegerDigits, "0")}${
    decimal === undefined ? "" : `.${decimal}`
  }`;
  const dotIndex = formatted.indexOf(".");
  const integerLength = dotIndex === -1 ? formatted.length : dotIndex;

  return (
    <span className="rolling-counter">
      <span className="visually-hidden">{formatted}</span>
      <span className="rolling-counter-display" aria-hidden="true">
        {reduceMotion
          ? formatted
          : Array.from(formatted, (character, index) => {
              if (character === ".") {
                return (
                  <span className="rolling-counter-decimal" key="decimal">
                    .
                  </span>
                );
              }

              const integerPlace = index < integerLength;
              const exponent = integerPlace
                ? integerLength - index - 1
                : integerLength - index;
              return (
                <Digit
                  key={
                    integerPlace ? `int-${exponent}` : `fraction-${-exponent}`
                  }
                  value={value}
                  place={10 ** exponent}
                />
              );
            })}
      </span>
    </span>
  );
}

export function ByteCounter({ size }: { size: number }) {
  const [number, unit] = formatBytes(size).split(" ");

  return (
    <>
      <Counter
        value={Number(number)}
        fractionDigits={number.includes(".") ? 1 : 0}
      />{" "}
      {unit}
    </>
  );
}
