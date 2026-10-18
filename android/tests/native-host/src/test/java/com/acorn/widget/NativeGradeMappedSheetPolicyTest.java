package com.acorn.widget;

import static org.junit.Assert.*;
import com.acorn.widget.gradesync.GradeMappedSheetPolicy;
import com.acorn.widget.gradesync.GradeMappedTemplate;
import com.acorn.widget.gradesync.SheetRequest;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Pure policy tests with synthetic fixtures. No accounts, consent, credentials or HTTP requests. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
public class NativeGradeMappedSheetPolicyTest {
  private static final String NATIVE_FILE = "synthetic_picker_selected_file";
  private interface Checked { void run() throws Exception; }
  private JSONObject mapping() throws Exception {
    return new JSONObject("{\"schemaVersion\":1,\"confirmed\":true,\"sheetId\":7,\"tab\":\"Synthetic's grades\",\"courses\":[{\"id\":\"synthetic\",\"title\":\"Synthetic course\",\"termId\":\"\",\"rules\":{\"kind\":\"weighted\"},\"assessments\":[{\"id\":\"quiz\",\"title\":\"Quiz\",\"gradeCell\":\"D4\",\"weightCell\":\"C4\",\"gradeMode\":\"ratio\",\"weightMode\":\"percentage\",\"anchor\":{\"cell\":\"B4\",\"text\":\"Quiz\"}},{\"id\":\"exam\",\"title\":\"Exam\",\"gradeCell\":\"D9\",\"weightCell\":\"C9\",\"gradeMode\":\"fraction\",\"weightMode\":\"percentage\",\"anchor\":{\"cell\":\"B9\",\"text\":\"Exam\"}}]}]}");
  }
  private JSONObject snapshot() throws Exception {
    return new JSONObject("{\"sheetId\":7,\"tab\":\"Synthetic's grades\",\"complete\":true,\"cells\":{\"A1\":{\"value\":\"Synthetic only\"},\"B4\":{\"value\":\"Quiz\"},\"C4\":{\"value\":20},\"D4\":{\"value\":0},\"B9\":{\"value\":\"Exam\"},\"C9\":{\"value\":80},\"D9\":{\"value\":\"\"},\"F20\":{\"value\":\"#DIV/0!\",\"formula\":true}}}");
  }
  private JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
  private JSONObject course(JSONObject mapping) throws Exception { return mapping.getJSONArray("courses").getJSONObject(0); }
  private JSONObject assessment(JSONObject mapping, int index) throws Exception { return course(mapping).getJSONArray("assessments").getJSONObject(index); }
  private JSONObject cell(JSONObject snapshot, String address) throws Exception { return snapshot.getJSONObject("cells").getJSONObject(address); }
  private JSONArray writes(String cell, Object value) throws Exception { return new JSONArray().put(new JSONObject().put("cell", cell).put("value", value)); }
  private GradeMappedSheetPolicy confirm(JSONObject mapping, JSONObject snapshot) { return GradeMappedSheetPolicy.confirm(NATIVE_FILE, mapping, snapshot); }
  private void rejects(String code, Checked action) throws Exception {
    try { action.run(); fail("Expected fail-closed policy: " + code); }
    catch (IllegalArgumentException expected) { assertEquals(code, expected.getMessage()); }
  }

  @Test public void syntheticZeroUngradedAndBrokenUnrelatedFormulaRemainIntact() throws Exception {
    JSONObject m = mapping(), s = snapshot();
    GradeMappedSheetPolicy policy = confirm(m, s);
    assertEquals(7, policy.getSheetId()); assertEquals("Synthetic's grades", policy.getTab());
    assertEquals(0, cell(s, "D4").getInt("value")); assertEquals("", cell(s, "D9").getString("value"));
    assertTrue(cell(s, "F20").getBoolean("formula")); assertFalse(policy.mappingJson().toString().contains(NATIVE_FILE));
    assessment(m, 0).put("gradeCell", "Z200");
    assessment(policy.mappingJson(), 0).put("gradeCell", "Z199");
    policy.prepareWrites(s, copy(s), writes("D4", 0.5));
    rejects("invalid-request", () -> policy.prepareWrites(s, s, writes("Z200", 0.5)));
  }

  @Test public void writeRequestPinsNativeFileRawOneCellRangesAndCanonicalOrder() throws Exception {
    JSONObject s = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), s);
    JSONArray changes = writes("D9", "40/50").put(new JSONObject().put("cell", "C4").put("value", 25));
    SheetRequest request = policy.prepareWrites(s, copy(s), changes);
    assertEquals("POST", request.getMethod()); assertEquals("sheets.googleapis.com", request.getHost());
    assertEquals("/v4/spreadsheets/" + NATIVE_FILE + "/values:batchUpdate", request.getPath());
    JSONObject body = request.getBody(); assertEquals(2, body.length()); assertEquals("RAW", body.getString("valueInputOption"));
    JSONArray data = body.getJSONArray("data"); assertEquals(2, data.length());
    assertEquals("'Synthetic''s grades'!C4", data.getJSONObject(0).getString("range"));
    assertEquals("'Synthetic''s grades'!D9", data.getJSONObject(1).getString("range"));
    for (int i = 0; i < data.length(); i++) {
      JSONObject entry = data.getJSONObject(i); assertEquals(3, entry.length()); assertEquals("ROWS", entry.getString("majorDimension"));
      assertEquals(1, entry.getJSONArray("values").length()); assertEquals(1, entry.getJSONArray("values").getJSONArray(0).length());
    }
    assertEquals("40/50", data.getJSONObject(1).getJSONArray("values").getJSONArray(0).getString(0));
  }

  @Test public void everyGradeModeAllowsLiteralPointsBlankAndItsNumericUnits() throws Exception {
    for (String mode : Arrays.asList("ratio", "percentage", "fraction")) {
      JSONObject m = mapping(), s = snapshot(); assessment(m, 0).put("gradeMode", mode);
      GradeMappedSheetPolicy policy = confirm(m, s);
      for (Object value : new Object[]{0, "", "0/50", "40/50", ".5/1.", mode.equals("percentage") ? 100 : 1}) {
        policy.prepareWrites(s, s, writes("D4", value));
        JSONObject observed = copy(s); cell(observed, "D4").put("value", value); policy.verifyWritten(observed, writes("D4", value));
      }
      rejects("invalid-request", () -> policy.prepareWrites(s, s, writes("D4", mode.equals("percentage") ? 100.1 : 1.1)));
    }
  }

  @Test public void weightsUseExplicitNumericUnitsAndCannotBeBlankOrFraction() throws Exception {
    JSONObject s = snapshot(); GradeMappedSheetPolicy percentage = confirm(mapping(), s);
    percentage.prepareWrites(s, s, writes("C4", 100)); percentage.prepareWrites(s, s, writes("C4", 0));
    JSONObject m = mapping(); assessment(m, 0).put("weightMode", "ratio"); cell(s, "C4").put("value", .2);
    GradeMappedSheetPolicy ratio = confirm(m, s); ratio.prepareWrites(s, s, writes("C4", 1));
    for (Object value : new Object[]{"", "20", "20%", "1/2", 1.1, -0.01, true, JSONObject.NULL, new JSONObject()})
      rejects("invalid-request", () -> ratio.prepareWrites(s, s, writes("C4", value)));
  }

  @Test public void rejectsEveryFormulaLikeOrMalformedGradeString() throws Exception {
    JSONObject s = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), s);
    for (Object value : new Object[]{"=1/2", "+1/2", "-1/2", "@SUM(A1)", " 1/2", "1/2 ", "1 / 2", "1/0", "2/1", "NaN", "Infinity", "0.5", "50%", "1e2/100", "1/2/3", "1.00000000000000000000001/1", true, JSONObject.NULL, new JSONArray(), new JSONObject(), -0.1})
      rejects("invalid-request", () -> policy.prepareWrites(s, s, writes("D4", value)));
  }

  @Test public void rejectsUnknownFieldsAtEveryMappingLevel() throws Exception {
    for (int level = 0; level < 5; level++) {
      JSONObject m = mapping();
      JSONObject target = level == 0 ? m : level == 1 ? course(m) : level == 2 ? course(m).getJSONObject("rules") : level == 3 ? assessment(m, 0) : assessment(m, 0).getJSONObject("anchor");
      target.put("spreadsheetId", "unselected_file"); rejects("invalid-mapping", () -> confirm(m, snapshot()));
    }
  }

  @Test public void rejectsCoercedMappingTypesMissingKeysAndUnconfirmedRules() throws Exception {
    for (String key : Arrays.asList("schemaVersion", "sheetId", "confirmed", "tab", "courses")) {
      JSONObject m = mapping(); m.put(key, key.equals("confirmed") ? "true" : key.equals("tab") ? 7 : "1");
      rejects("invalid-mapping", () -> confirm(m, snapshot()));
      JSONObject missing = mapping(); missing.remove(key); rejects("invalid-mapping", () -> confirm(missing, snapshot()));
    }
    JSONObject negative = mapping(); negative.put("sheetId", -1); rejects("invalid-mapping", () -> confirm(negative, snapshot()));
    JSONObject fractional = mapping(); fractional.put("sheetId", 7.5); rejects("invalid-mapping", () -> confirm(fractional, snapshot()));
    JSONObject large = mapping(); large.put("sheetId", 2147483648L); rejects("invalid-mapping", () -> confirm(large, snapshot()));
    JSONObject unconfirmed = mapping(); unconfirmed.put("confirmed", false); rejects("invalid-mapping", () -> confirm(unconfirmed, snapshot()));
    JSONObject rules = mapping(); course(rules).getJSONObject("rules").put("kind", "drop-lowest"); rejects("invalid-mapping", () -> confirm(rules, snapshot()));
    JSONObject allowed = mapping(); course(allowed).getJSONObject("rules").put("kind", "unconfirmed"); confirm(allowed, snapshot());
  }

  @Test public void rejectsNoncanonicalCoordinatesInMappingAndWrites() throws Exception {
    JSONObject s = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), s);
    for (String address : Arrays.asList("AA1", "Z201", "A0", "A01", "a1", "A1:B2", "Other!D4", "D4?x=1", "$D$4", " D4", "D4\n", "A-1")) {
      JSONObject m = mapping(); assessment(m, 0).put("gradeCell", address); rejects("invalid-mapping", () -> confirm(m, s));
      rejects("invalid-request", () -> policy.prepareWrites(s, s, writes(address, 0.5)));
    }
  }

  @Test public void permitsBoundedLastCellButNeverAdjacentOutOfRange() throws Exception {
    JSONObject m = mapping(), s = snapshot(); assessment(m, 0).put("gradeCell", "Z200");
    s.getJSONObject("cells").put("Z200", new JSONObject().put("value", 0));
    SheetRequest request = confirm(m, s).prepareWrites(s, s, writes("Z200", 1));
    assertEquals("'Synthetic''s grades'!Z200", request.getBody().getJSONArray("data").getJSONObject(0).getString("range"));
  }

  @Test public void rejectsDuplicateIdsTargetsAnchorsAndLabelWriteOverlap() throws Exception {
    JSONObject duplicateCourse = mapping(); duplicateCourse.getJSONArray("courses").put(copy(course(duplicateCourse))); rejects("invalid-mapping", () -> confirm(duplicateCourse, snapshot()));
    JSONObject duplicateId = mapping(); assessment(duplicateId, 1).put("id", "quiz"); rejects("invalid-mapping", () -> confirm(duplicateId, snapshot()));
    JSONObject duplicateTarget = mapping(); assessment(duplicateTarget, 1).put("weightCell", "D4"); rejects("invalid-mapping", () -> confirm(duplicateTarget, snapshot()));
    JSONObject ownTarget = mapping(); assessment(ownTarget, 0).put("weightCell", "D4"); rejects("invalid-mapping", () -> confirm(ownTarget, snapshot()));
    JSONObject labelTarget = mapping(); assessment(labelTarget, 0).getJSONObject("anchor").put("cell", "C9"); rejects("invalid-mapping", () -> confirm(labelTarget, snapshot()));
    JSONObject duplicateAnchor = mapping(); assessment(duplicateAnchor, 1).getJSONObject("anchor").put("cell", "B4"); rejects("invalid-mapping", () -> confirm(duplicateAnchor, snapshot()));
  }

  @Test public void formulaProtectedAndMergedGradeOrWeightAlwaysBlock() throws Exception {
    for (String address : Arrays.asList("D4", "C4", "D9", "C9")) for (String flag : Arrays.asList("formula", "protected", "merged")) {
      JSONObject s = snapshot(); cell(s, address).put(flag, true); rejects("mapping-changed", () -> confirm(mapping(), s));
      JSONObject clean = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), clean);
      rejects("mapping-changed", () -> policy.prepareWrites(s, clean, writes("D4", 0.5)));
      rejects("mapping-changed", () -> policy.verifyWritten(s, writes("D4", 0)));
    }
  }

  @Test public void anchorDriftFormulaAndMergeBlockButProtectedLabelsAreAllowed() throws Exception {
    JSONObject protectedLabel = snapshot(); cell(protectedLabel, "B4").put("protected", true); confirm(mapping(), protectedLabel);
    for (String field : Arrays.asList("value", "formula", "merged")) {
      JSONObject s = snapshot(); cell(s, "B4").put(field, field.equals("value") ? "Moved quiz" : true);
      rejects("mapping-changed", () -> confirm(mapping(), s));
    }
  }

  @Test public void snapshotRequiresExactTabIdCompleteAndExplicitReferencedCells() throws Exception {
    JSONObject[] bad = { snapshot().put("tab", "Other"), snapshot().put("sheetId", 8), snapshot().put("sheetId", "7"), snapshot().put("complete", false), snapshot().put("complete", "true"), snapshot().put("url", "https://invalid.example") };
    for (JSONObject s : bad) rejects("mapping-changed", () -> confirm(mapping(), s));
    for (String address : Arrays.asList("B4", "C4", "D4")) {
      JSONObject s = snapshot(); s.getJSONObject("cells").remove(address); rejects("mapping-changed", () -> confirm(mapping(), s));
    }
    JSONObject s = snapshot(); s.remove("cells"); rejects("mapping-changed", () -> confirm(mapping(), s));
  }

  @Test public void malformedCellMetadataAndNestedValuesFailClosedEvenWhenUnrelated() throws Exception {
    for (String key : Arrays.asList("formula", "protected", "merged")) {
      JSONObject s = snapshot(); cell(s, "A1").put(key, "false"); rejects("mapping-changed", () -> confirm(mapping(), s));
    }
    for (Object value : new Object[]{JSONObject.NULL, new JSONArray(), new JSONObject(), "null\u0000byte"}) {
      JSONObject s = snapshot(); cell(s, "A1").put("value", value); rejects("mapping-changed", () -> confirm(mapping(), s));
    }
    JSONObject unknown = snapshot(); cell(unknown, "A1").put("userEnteredValue", new JSONObject()); rejects("mapping-changed", () -> confirm(mapping(), unknown));
    JSONObject missing = snapshot(); cell(missing, "A1").remove("value"); rejects("mapping-changed", () -> confirm(mapping(), missing));
    JSONObject outside = snapshot(); outside.getJSONObject("cells").put("AA1", new JSONObject().put("value", "")); rejects("mapping-changed", () -> confirm(mapping(), outside));
  }

  @Test public void freshComparisonCoversEveryMappedValueIncludingUnwrittenTargets() throws Exception {
    JSONObject expected = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), expected);
    for (String address : Arrays.asList("D4", "C4", "D9", "C9")) {
      JSONObject current = copy(expected); cell(current, address).put("value", address.startsWith("C") ? 30 : 0.5);
      rejects("conflict", () -> policy.prepareWrites(current, expected, writes("D4", 0.75)));
    }
    JSONObject changedLabelProtection = copy(expected); cell(changedLabelProtection, "B4").put("protected", true);
    rejects("conflict", () -> policy.prepareWrites(changedLabelProtection, expected, writes("D4", 0.5)));
    JSONObject equivalent = copy(expected); cell(equivalent, "D4").put("value", 0.0).put("formula", false).put("protected", false).put("merged", false);
    policy.prepareWrites(equivalent, expected, writes("D4", 0.5));
  }

  @Test public void unrelatedChangesDoNotEnterWriteSetOrConflictCheck() throws Exception {
    JSONObject expected = snapshot(), current = copy(expected); GradeMappedSheetPolicy policy = confirm(mapping(), expected);
    cell(current, "A1").put("value", "Changed unrelated note").put("protected", true).put("merged", true);
    cell(current, "F20").put("value", "#REF!");
    String before = current.toString(); SheetRequest request = policy.prepareWrites(current, expected, writes("D4", 0.25));
    assertEquals(before, current.toString()); assertEquals(1, request.getBody().getJSONArray("data").length());
    assertFalse(request.getBody().toString().contains("F20")); assertFalse(request.getBody().toString().contains("A1"));
  }

  @Test public void writeListCannotIntroducePathsFlagsExtraFieldsDuplicateOrUnmappedCells() throws Exception {
    JSONObject s = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), s);
    for (String key : Arrays.asList("path", "sheetId", "spreadsheetId", "range", "formula", "valueInputOption")) {
      JSONArray list = writes("D4", 0.5); list.getJSONObject(0).put(key, "untrusted");
      rejects("invalid-request", () -> policy.prepareWrites(s, s, list));
    }
    rejects("invalid-request", () -> policy.prepareWrites(s, s, writes("F20", 0.5)));
    rejects("invalid-request", () -> policy.prepareWrites(s, s, writes("B4", 0.5)));
    rejects("invalid-request", () -> policy.prepareWrites(s, s, writes("D4", 0.5).put(writes("D4", 0.75).getJSONObject(0))));
    rejects("invalid-request", () -> policy.prepareWrites(s, s, new JSONArray().put("D4")));
    rejects("invalid-request", () -> policy.prepareWrites(s, s, new JSONArray().put(new JSONObject().put("cell", "D4"))));
  }

  @Test public void readbackRequiresObservedRequestedValuesAndStillValidMapping() throws Exception {
    JSONObject before = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), before);
    JSONArray list = writes("D4", "40/50"); JSONObject written = copy(before); cell(written, "D4").put("value", "40/50");
    policy.verifyWritten(written, list); rejects("conflict", () -> policy.verifyWritten(before, list));
    JSONObject changed = copy(written); cell(changed, "D4").put("value", "4/5"); rejects("conflict", () -> policy.verifyWritten(changed, list));
    JSONObject moved = copy(written); cell(moved, "B4").put("value", "Different"); rejects("mapping-changed", () -> policy.verifyWritten(moved, list));
    JSONObject formula = copy(written); cell(formula, "D4").put("formula", true); rejects("mapping-changed", () -> policy.verifyWritten(formula, list));
    rejects("invalid-request", () -> policy.verifyWritten(written, writes("A1", "40/50")));
  }

  @Test public void mappingAndBatchBoundsAreEnforcedBeforeNetwork() throws Exception {
    JSONObject s = snapshot(); GradeMappedSheetPolicy policy = confirm(mapping(), s);
    rejects("limit-exceeded", () -> policy.prepareWrites(s, s, new JSONArray()));
    JSONArray tooManyWrites = new JSONArray(); for (int i = 0; i <= GradeMappedSheetPolicy.MAX_WRITES; i++) tooManyWrites.put(writes("D4", 0).getJSONObject(0));
    rejects("limit-exceeded", () -> policy.prepareWrites(s, s, tooManyWrites));
    JSONObject manyCourses = mapping(); JSONArray courses = new JSONArray(); for (int i = 0; i <= GradeMappedSheetPolicy.MAX_COURSES; i++) courses.put(copy(course(manyCourses)));
    manyCourses.put("courses", courses); rejects("limit-exceeded", () -> confirm(manyCourses, s));
    JSONObject manyAssessments = mapping(); JSONArray assessments = new JSONArray(); for (int i = 0; i <= GradeMappedSheetPolicy.MAX_ASSESSMENTS; i++) assessments.put(copy(assessment(manyAssessments, 0)));
    course(manyAssessments).put("assessments", assessments); rejects("limit-exceeded", () -> confirm(manyAssessments, s));
    JSONObject huge = mapping().put("unexpected", "x".repeat(GradeMappedSheetPolicy.MAX_MAPPING_BYTES)); rejects("limit-exceeded", () -> confirm(huge, s));
  }

  @Test public void emptyAndOversizedIdentityFieldsAreRejectedWithoutCoercion() throws Exception {
    for (Object value : new Object[]{"", " ", "x".repeat(201), 5, "bad\nidentifier"}) {
      JSONObject m = mapping(); course(m).put("id", value); rejects("invalid-mapping", () -> confirm(m, snapshot()));
    }
    JSONObject m = mapping(); assessment(m, 0).getJSONObject("anchor").put("text", " "); rejects("invalid-mapping", () -> confirm(m, snapshot()));
    for (String file : Arrays.asList("", "../other", "https://invalid.example", "a/b", "x".repeat(201)))
      rejects("invalid-mapping", () -> GradeMappedSheetPolicy.confirm(file, mapping(), snapshot()));
  }

  @Test public void completeBoundedGridIsAcceptedWithBooleansAndBlankUnrelatedCells() throws Exception {
    JSONObject s = snapshot(); JSONObject cells = s.getJSONObject("cells");
    for (int row = 1; row <= 200; row++) for (char column = 'A'; column <= 'Z'; column++) {
      String address = "" + column + row;
      if (!cells.has(address)) cells.put(address, new JSONObject().put("value", "").put("formula", false).put("protected", false).put("merged", false));
    }
    cell(s, "Z200").put("value", true); assertEquals(5200, cells.length());
    confirm(mapping(), s).prepareWrites(s, copy(s), writes("D4", 0.5));
  }

  private JSONObject templateCourse() throws Exception {
    return new JSONObject("{\"id\":\"synthetic\",\"title\":\"Synthetic grade course\",\"termId\":\"fall\",\"rules\":{\"kind\":\"unconfirmed\"},\"assessments\":[{\"id\":\"zero\",\"title\":\"Zero earned\",\"weight\":0.2,\"status\":\"graded\",\"score\":{\"mode\":\"ratio\",\"value\":0}},{\"id\":\"points\",\"title\":\"Points earned\",\"weight\":0.3,\"status\":\"graded\",\"score\":{\"mode\":\"points\",\"earned\":40,\"possible\":50}},{\"id\":\"pending\",\"title\":\"Still pending\",\"weight\":0.5,\"status\":\"ungraded\",\"score\":null}]}");
  }
  private JSONArray templateRows(GradeMappedTemplate template) throws Exception {
    return template.request().getJSONArray("sheets").getJSONObject(0).getJSONArray("data").getJSONObject(0).getJSONArray("rowData");
  }
  private JSONObject templateEntered(JSONArray rows, int row, int column) throws Exception {
    return rows.getJSONObject(row).getJSONArray("values").getJSONObject(column).getJSONObject("userEnteredValue");
  }
  private JSONObject templateSnapshot(GradeMappedTemplate template, int sheetId) throws Exception {
    JSONObject cells = new JSONObject(); JSONArray rows = templateRows(template);
    for (int r = 0; r < rows.length(); r++) {
      JSONArray columns = rows.getJSONObject(r).getJSONArray("values");
      for (int c = 0; c < columns.length(); c++) {
        JSONObject entered = columns.getJSONObject(c).getJSONObject("userEnteredValue");
        boolean formula = entered.has("formulaValue");
        Object value = formula ? 0 : entered.has("numberValue") ? entered.get("numberValue") : entered.get("stringValue");
        cells.put("" + (char)('A' + c) + (r + 1), new JSONObject().put("value", value).put("formula", formula).put("protected", false).put("merged", false));
      }
    }
    return new JSONObject().put("sheetId", sheetId).put("tab", template.getTab()).put("complete", true).put("cells", cells);
  }

  @Test public void nativeTemplateDerivesHumanHeadersExplicitZeroPointsAndUngraded() throws Exception {
    GradeMappedTemplate template = GradeMappedTemplate.build(templateCourse()); JSONArray rows = templateRows(template);
    assertEquals("Grades", template.getTab()); assertEquals("Synthetic grade course", template.getTitle());
    for (int i = 0; i < 4; i++) assertEquals(new String[]{"Assessment", "Weight", "Grade", "Contribution"}[i], templateEntered(rows, 0, i).getString("stringValue"));
    assertEquals(0.0, templateEntered(rows, 1, 2).getDouble("numberValue"), 0);
    assertEquals("40/50", templateEntered(rows, 2, 2).getString("stringValue"));
    assertEquals("", templateEntered(rows, 3, 2).getString("stringValue"));
    assertEquals(.2, templateEntered(rows, 1, 1).getDouble("numberValue"), 0);
    JSONObject properties = template.request().getJSONArray("sheets").getJSONObject(0).getJSONObject("properties");
    assertEquals(0, properties.getInt("sheetId")); assertEquals(200, properties.getJSONObject("gridProperties").getInt("rowCount"));
    assertEquals(26, properties.getJSONObject("gridProperties").getInt("columnCount")); assertEquals(1, properties.getJSONObject("gridProperties").getInt("frozenRowCount"));
  }

  @Test public void nativeTemplateUsesOnlyTrustedZeroAwareContributionAndSummaryFormulas() throws Exception {
    GradeMappedTemplate template = GradeMappedTemplate.build(templateCourse()); JSONArray rows = templateRows(template);
    assertEquals("=IF(C2=\"\",\"\",B2*IF(ISNUMBER(C2),C2,VALUE(INDEX(SPLIT(C2,\"/\"),1,1))/VALUE(INDEX(SPLIT(C2,\"/\"),1,2))))", templateEntered(rows, 1, 3).getString("formulaValue"));
    assertFalse(template.request().toString().contains("IFERROR"));
    assertEquals(0, rows.getJSONObject(4).getJSONArray("values").length());
    assertEquals("Total weight", templateEntered(rows, 5, 0).getString("stringValue"));
    assertEquals("=SUM(B2:B4)", templateEntered(rows, 5, 1).getString("formulaValue"));
    assertEquals("=SUM(D2:D4)", templateEntered(rows, 6, 1).getString("formulaValue"));
    assertEquals("=SUMIF(C2:C4,\"<>\",B2:B4)", templateEntered(rows, 7, 1).getString("formulaValue"));
    assertEquals("=IF(SUMIF(C2:C4,\"<>\",B2:B4)=0,\"\",SUM(D2:D4)/SUMIF(C2:C4,\"<>\",B2:B4))", templateEntered(rows, 8, 1).getString("formulaValue"));
  }

  @Test public void nativeTemplateMappingIsDerivedAndPassesGuardWithoutTrustingCallerMapping() throws Exception {
    JSONObject input = templateCourse(); GradeMappedTemplate template = GradeMappedTemplate.build(input);
    JSONObject mapping = template.mapping(23), snapshot = templateSnapshot(template, 23);
    assertEquals("unconfirmed", course(mapping).getJSONObject("rules").getString("kind"));
    assertEquals("C2", assessment(mapping, 0).getString("gradeCell")); assertEquals("B2", assessment(mapping, 0).getString("weightCell"));
    assertEquals("A2", assessment(mapping, 0).getJSONObject("anchor").getString("cell"));
    assertEquals("Zero earned", assessment(mapping, 0).getJSONObject("anchor").getString("text"));
    GradeMappedSheetPolicy policy = confirm(mapping, snapshot); policy.prepareWrites(snapshot, snapshot, writes("C2", "25/50"));
    input.put("title", "Changed after validation"); template.request().getJSONObject("properties").put("title", "Changed defensive copy");
    assertEquals("Synthetic grade course", template.request().getJSONObject("properties").getString("title"));
    course(mapping).put("id", "Changed mapping copy"); assertEquals("synthetic", course(template.mapping(23)).getString("id"));
    rejects("invalid-mapping", () -> template.mapping(-1));
  }

  @Test public void nativeTemplateTreatsFormulaLikeUserLabelsAsLiteralTextOnly() throws Exception {
    JSONObject course = templateCourse(); String label = "=IMPORTXML(\"https://invalid.example\",\"x\")";
    course.getJSONArray("assessments").getJSONObject(0).put("title", label);
    GradeMappedTemplate template = GradeMappedTemplate.build(course); JSONObject entered = templateEntered(templateRows(template), 1, 0);
    assertEquals(label, entered.getString("stringValue")); assertFalse(entered.has("formulaValue"));
    assertEquals(label, assessment(template.mapping(0), 0).getJSONObject("anchor").getString("text"));
    confirm(template.mapping(0), templateSnapshot(template, 0));
  }

  @Test public void nativeTemplateRejectsArbitraryRowsFormulasExemptionsAndMalformedScores() throws Exception {
    for (String key : Arrays.asList("rows", "mapping", "formulas", "spreadsheetId", "sheetId")) {
      JSONObject c = templateCourse(); c.put(key, new JSONObject()); rejects("invalid-request", () -> GradeMappedTemplate.build(c));
    }
    JSONObject exempt = templateCourse(); exempt.getJSONArray("assessments").getJSONObject(2).put("status", "exempt"); rejects("invalid-request", () -> GradeMappedTemplate.build(exempt));
    JSONObject leakedScore = templateCourse(); leakedScore.getJSONArray("assessments").getJSONObject(2).put("score", new JSONObject().put("mode", "ratio").put("value", 0)); rejects("invalid-request", () -> GradeMappedTemplate.build(leakedScore));
    JSONObject extraScore = templateCourse(); extraScore.getJSONArray("assessments").getJSONObject(0).getJSONObject("score").put("formula", "=1"); rejects("invalid-request", () -> GradeMappedTemplate.build(extraScore));
    JSONObject wrongWeight = templateCourse(); wrongWeight.getJSONArray("assessments").getJSONObject(0).put("weight", "0.2"); rejects("invalid-request", () -> GradeMappedTemplate.build(wrongWeight));
    JSONObject badPoints = templateCourse(); badPoints.getJSONArray("assessments").getJSONObject(1).getJSONObject("score").put("possible", 0); rejects("invalid-request", () -> GradeMappedTemplate.build(badPoints));
    JSONObject duplicated = templateCourse(); duplicated.getJSONArray("assessments").getJSONObject(1).put("id", "zero"); rejects("invalid-request", () -> GradeMappedTemplate.build(duplicated));
  }

  @Test public void nativeTemplateRequiresOneTo190AssessmentsAndFitsPreviewBounds() throws Exception {
    JSONObject empty = templateCourse().put("assessments", new JSONArray()); rejects("limit-exceeded", () -> GradeMappedTemplate.build(empty));
    JSONObject course = templateCourse(); JSONObject seed = copy(course.getJSONArray("assessments").getJSONObject(0)); JSONArray all = new JSONArray();
    for (int i = 0; i < GradeMappedTemplate.MAX_ASSESSMENTS; i++) all.put(copy(seed).put("id", "synthetic_" + i).put("title", "Assessment " + i));
    course.put("assessments", all); GradeMappedTemplate template = GradeMappedTemplate.build(course);
    assertEquals(196, templateRows(template).length()); assertEquals("C191", assessment(template.mapping(0), 189).getString("gradeCell"));
    confirm(template.mapping(0), templateSnapshot(template, 0));
    all.put(copy(seed).put("id", "one_too_many")); rejects("limit-exceeded", () -> GradeMappedTemplate.build(course));
  }

  @Test public void nativeTemplateConvertsSmallPointNumbersToSafePlainFractionStrings() throws Exception {
    JSONObject course = templateCourse(); JSONObject score = course.getJSONArray("assessments").getJSONObject(1).getJSONObject("score");
    score.put("earned", .0000001).put("possible", .0000002);
    GradeMappedTemplate template = GradeMappedTemplate.build(course); assertEquals("0.0000001/0.0000002", templateEntered(templateRows(template), 2, 2).getString("stringValue"));
    confirm(template.mapping(0), templateSnapshot(template, 0));
    score.put("earned", 1e100).put("possible", 1e101); rejects("limit-exceeded", () -> GradeMappedTemplate.build(course));
  }

  @Test public void createdTemplateReadbackRequiresEveryRequestedInitialGradeAndWeight() throws Exception {
    JSONObject course = templateCourse(); course.getJSONArray("assessments").getJSONObject(0).getJSONObject("score").put("value", .8);
    GradeMappedTemplate template = GradeMappedTemplate.build(course); JSONObject snapshot = templateSnapshot(template, 23);
    template.verifyCreated(snapshot);
    JSONObject changedGrade = copy(snapshot); cell(changedGrade, "C2").put("value", .2);
    rejects("conflict", () -> template.verifyCreated(changedGrade));
    for (String address : Arrays.asList("B2", "B3", "B4")) {
      JSONObject changedWeight = copy(snapshot); cell(changedWeight, address).put("value", .9);
      rejects("conflict", () -> template.verifyCreated(changedWeight));
    }
    JSONObject differentFraction = copy(snapshot); cell(differentFraction, "C3").put("value", "4/5");
    rejects("conflict", () -> template.verifyCreated(differentFraction));
    course.getJSONArray("assessments").getJSONObject(0).getJSONObject("score").put("value", .2);
    rejects("conflict", () -> template.verifyCreated(changedGrade));
  }

  @Test public void createdTemplateReadbackPreservesBlankVersusZeroAndRejectsMissingValues() throws Exception {
    GradeMappedTemplate template = GradeMappedTemplate.build(templateCourse()); JSONObject snapshot = templateSnapshot(template, 0);
    cell(snapshot, "C2").put("value", 0); template.verifyCreated(snapshot);
    JSONObject erasedZero = copy(snapshot); cell(erasedZero, "C2").put("value", "");
    rejects("conflict", () -> template.verifyCreated(erasedZero));
    JSONObject convertedPending = copy(snapshot); cell(convertedPending, "C4").put("value", 0);
    rejects("conflict", () -> template.verifyCreated(convertedPending));
    for (String address : Arrays.asList("B2", "C2", "C3", "C4", "A2")) {
      JSONObject missing = copy(snapshot); missing.getJSONObject("cells").remove(address);
      rejects("mapping-changed", () -> template.verifyCreated(missing));
    }
  }

  @Test public void createdTemplateReadbackStillRejectsChangedLabelsUnsafeCellsAndMalformedTabIds() throws Exception {
    GradeMappedTemplate template = GradeMappedTemplate.build(templateCourse()); JSONObject snapshot = templateSnapshot(template, 0);
    JSONObject changedLabel = copy(snapshot); cell(changedLabel, "A2").put("value", "Moved assessment");
    rejects("mapping-changed", () -> template.verifyCreated(changedLabel));
    for (String flag : Arrays.asList("formula", "protected", "merged")) {
      JSONObject unsafe = copy(snapshot); cell(unsafe, "C2").put(flag, true);
      rejects("mapping-changed", () -> template.verifyCreated(unsafe));
    }
    for (Object id : new Object[]{"0", -1, .5, 2147483648L, JSONObject.NULL}) {
      JSONObject malformed = copy(snapshot).put("sheetId", id);
      rejects("mapping-changed", () -> template.verifyCreated(malformed));
    }
  }
}
