// check-tsc-baseline.test.ts —— G9 闸门判别力自证·单测段（规格 §②.4a）
// 伪造 tsc 输出喂解析/比对/守卫函数：新增签名必红、计数+1 必红、收敛不拦、
// 真空自毁必红、sanity 下限必红（含 TS5101 真空检查实锤形态——架构师实测 1 ≤ 7255 假绿陷阱）。
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  buildSignatures,
  compareSignatures,
  normalizeFilePath,
  normalizeMessage,
  parsePositionlessErrors,
  parseTscOutput,
  sanityCheck,
} from "./check-tsc-baseline";

describe("G9 parsePositionlessErrors（观测：config 级错误证据）", () => {
  test("无位置 config 错误行被拾取（真空形态来源）", () => {
    const hits = parsePositionlessErrors("error TS18003: No inputs were found in config file.");
    expect(hits).toEqual(["error TS18003: No inputs were found in config file."]);
  });
  test("带位置的行不重复收", () => {
    const hits = parsePositionlessErrors("src/a.ts(1,1): error TS2322: Type 'x' is wrong.");
    expect(hits).toEqual([]);
  });
  test("普通伴随文本行不拾取", () => {
    const hits = parsePositionlessErrors("Visit https://aka.ms/ts6 for migration information.");
    expect(hits).toEqual([]);
  });
});

describe("G9 normalizeFilePath（主目录折叠，跨机器稳定）", () => {
  test("本机主目录前缀折叠为 ~/（bun-types 缓存类绝对路径）", () => {
    const home = homedir().replace(/\\/g, "/");
    expect(normalizeFilePath(`${home}/.bun/install/cache/bun-types@1.4.2/bun.d.ts`)).toBe(
      "~/.bun/install/cache/bun-types@1.4.2/bun.d.ts",
    );
  });
  test("相对路径不变", () => {
    expect(normalizeFilePath("src/utils/array.ts")).toBe("src/utils/array.ts");
  });
});

const LINE = (file: string, line: number, col: number, code: string, msg: string) =>
  `${file}(${line},${col}): ${code}: ${msg}`;

describe("G9 parseTscOutput", () => {
  test("解析诊断行：file/line/col/code/message", () => {
    const out = parseTscOutput(
      [
        LINE("src/a.ts", 10, 5, "error TS2322", "Type 'number' is not assignable to type 'string'."),
        "",
        "  Types of property 'x' are incompatible.", // 续行（related information）不入签名
        LINE("tests/b.test.ts", 2, 15, "error TS2614", "Module '\"../src/types/message.js\"' has no exported member 'X'."),
      ].join("\n"),
    );
    expect(out.length).toBe(2);
    expect(out[0].file).toBe("src/a.ts");
    expect(out[0].code).toBe("error TS2322");
    expect(out[0].message).toContain("not assignable");
  });

  test("Windows 反斜杠路径归一为正斜杠", () => {
    const out = parseTscOutput(LINE("src\\server\\a.ts", 1, 1, "error TS7006", "Parameter 'x' implicitly has an 'any' type."));
    expect(out[0].file).toBe("src/server/a.ts");
  });

  test("行号不入签名：同错误不同行号 = 同一签名", () => {
    const s1 = buildSignatures(parseTscOutput(LINE("src/a.ts", 10, 5, "error TS2322", "boom")));
    const s2 = buildSignatures(parseTscOutput(LINE("src/a.ts", 99, 33, "error TS2322", "boom")));
    expect([...s1.keys()]).toEqual([...s2.keys()]);
  });
});

describe("G9 normalizeMessage", () => {
  test("数字串占位防漂移", () => {
    expect(normalizeMessage("Expected 3 arguments, but got 2.")).toBe("Expected N arguments, but got N.");
  });
  test("仅取首行", () => {
    expect(normalizeMessage("first\nsecond")).toBe("first");
  });
});

describe("G9 compareSignatures（只紧不松）", () => {
  const sig = (k: string, n: number) => new Map([[k, n]]);

  test("新增签名必红", () => {
    const r = compareSignatures(
      new Map([["a.ts::TS2322::x", 1], ["b.ts::TS7006::y", 2]]),
      sig("a.ts::TS2322::x", 1),
    );
    expect(r.pass).toBe(false);
    expect(r.added).toContainEqual(["b.ts::TS7006::y", 2]);
  });

  test("同签名计数 +1 必红", () => {
    const r = compareSignatures(sig("a.ts::TS2322::x", 2), sig("a.ts::TS2322::x", 1));
    expect(r.pass).toBe(false);
    expect(r.exceeded).toContainEqual(["a.ts::TS2322::x", 2, 1]);
  });

  test("签名缺失（合法收敛）不拦", () => {
    const r = compareSignatures(
      sig("a.ts::TS2322::x", 1),
      new Map([["a.ts::TS2322::x", 1], ["b.ts::TS7006::y", 4]]),
    );
    expect(r.pass).toBe(true);
    expect(r.currentTotal).toBe(1);
    expect(r.baselineTotal).toBe(5);
  });

  test("计数下降不拦", () => {
    const r = compareSignatures(sig("a.ts::TS2322::x", 3), sig("a.ts::TS2322::x", 5));
    expect(r.pass).toBe(true);
  });
});

describe("G9 sanityCheck（真空自毁 + 下限）", () => {
  test("exit≠0 且 0 诊断 ⇒ 闸门失效判红", () => {
    expect(sanityCheck(0, 2, 7255).ok).toBe(false);
  });
  test("TS5101 真空检查形态（1 条 config 错误 + exit 2）⇒ sanity 拦截", () => {
    // 架构师实测：TS6 + baseUrl 无旗标 ⇒ 仅 1 条 TS5101、0 文件被检；若无 sanity，「1 ≤ 7255」式闸门假绿
    expect(sanityCheck(1, 2, 7255).ok).toBe(false);
  });
  test("总数骤降 <50% 基线 ⇒ 判红", () => {
    expect(sanityCheck(3000, 2, 7255).ok).toBe(false);
  });
  test("≥50% 正常放行", () => {
    expect(sanityCheck(4000, 2, 7255).ok).toBe(true);
  });
  test("全清（exit 0 + 0 诊断）在存量基线下同样被下限拦住", () => {
    expect(sanityCheck(0, 0, 7255).ok).toBe(false);
  });
});
