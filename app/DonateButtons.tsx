"use client";

import { useState } from "react";
import Image from "next/image";

import styles from "./page.module.css";

const BTC_ADDRESS = "bc1q5xeyqmxavll2ecs339n4ludgdws83hu20y5q98";
const ETH_ADDRESS = "0xF3294fC7b634eb03f50929a065b6Ac3dfF492c48";

export function DonateButtons() {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (key: string, address: string) => {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const button = (key: string, address: string) => {
    return (
      <button
        className={[styles.button, styles.donateButton].join(" ")}
        onClick={() => copyToClipboard(key, address)}
        title={address}
      >
        {copied === key ? (
          "Copied!"
        ) : (
          <Image src={`/${key}.svg`} alt={key} width={20} height={20} />
        )}
      </button>
    );
  };

  return (
    <div className={styles.donateBar}>
      <span className={styles.donateLabel}>Support this work:</span>
      {button("btc", BTC_ADDRESS)}
      {button("eth", ETH_ADDRESS)}
    </div>
  );
}
