import { describe, expect, it } from "vitest";
import { describeGroup, groupsEachPage, groupsEveryN, parsePageRanges } from "../src";

describe("parsePageRanges", () => {
  it("解析單頁、範圍與開放範圍", () => {
    expect(parsePageRanges("1-3, 5, 8-", 10)).toEqual([[0, 1, 2], [4], [7, 8, 9]]);
    expect(parsePageRanges("-2", 10)).toEqual([[0, 1]]);
  });

  it("接受全形逗號、頓號、空白與各種破折號", () => {
    expect(parsePageRanges("1～2，3、 4 – 5", 5)).toEqual([[0, 1], [2], [3, 4]]);
    expect(parsePageRanges(" 1 - 2  4 ", 5)).toEqual([[0, 1], [3]]);
  });

  it("倒序範圍產生倒序頁面", () => {
    expect(parsePageRanges("3-1", 3)).toEqual([[2, 1, 0]]);
  });

  it.each([
    ["", "請輸入"],
    ["0", "超出範圍"],
    ["11", "超出範圍"],
    ["2-20", "超出範圍"],
    ["a", "看不懂"],
    ["1-2-3", "看不懂"],
    ["-", "看不懂"],
  ])("「%s」回報錯誤", (spec, msg) => {
    expect(() => parsePageRanges(spec, 10)).toThrow(msg);
  });
});

describe("groups helpers", () => {
  it("groupsEachPage", () => {
    expect(groupsEachPage(3)).toEqual([[0], [1], [2]]);
  });

  it("groupsEveryN 最後一組可以不足", () => {
    expect(groupsEveryN(7, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(groupsEveryN(2, 5)).toEqual([[0, 1]]);
  });

  it("groupsEveryN 拒絕非正整數", () => {
    expect(() => groupsEveryN(5, 0)).toThrow();
    expect(() => groupsEveryN(5, 1.5)).toThrow();
  });

  it("describeGroup", () => {
    expect(describeGroup([0, 1, 2])).toBe("1-3");
    expect(describeGroup([4])).toBe("5");
    expect(describeGroup([0, 1, 2, 4, 6, 7])).toBe("1-3,5,7-8");
    expect(describeGroup([2, 1, 0])).toBe("3-1");
  });
});
