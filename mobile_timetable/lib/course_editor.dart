import 'package:flutter/material.dart';
import 'timetable.dart';
import 'app_theme.dart';

class CourseEditor extends StatefulWidget {
  const CourseEditor({
    super.key,
    this.course,
    required this.weekday,
    this.onDelete,
  });
  final Course? course;
  final int weekday;
  final Future<bool> Function()? onDelete;
  @override
  State<CourseEditor> createState() => _CourseEditorState();
}

class _CourseEditorState extends State<CourseEditor> {
  final form = GlobalKey<FormState>();
  late final TextEditingController title, location, link, notes;
  late int weekday, start, end, color;
  String? startDate, endDate;
  @override
  void initState() {
    super.initState();
    final c = widget.course;
    title = TextEditingController(text: c?.title ?? '');
    location = TextEditingController(text: c?.location ?? '');
    link = TextEditingController(text: c?.mapUrl ?? '');
    notes = TextEditingController(text: c?.notes ?? '');
    weekday = c?.weekday ?? widget.weekday;
    start = c?.startMinutes ?? 540;
    end = c?.endMinutes ?? 630;
    color = c?.color ?? courseColors.first;
    startDate = c?.startDate;
    endDate = c?.endDate;
  }

  @override
  void dispose() {
    title.dispose();
    location.dispose();
    link.dispose();
    notes.dispose();
    super.dispose();
  }

  Future<void> _pickTime(bool isStart) async {
    final value = isStart ? start : end;
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: (value ~/ 60) % 24, minute: value % 60),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: true),
        child: child!,
      ),
    );
    if (picked != null && mounted)
      setState(() {
        if (isStart) {
          start = picked.hour * 60 + picked.minute;
        } else {
          end = picked.hour * 60 + picked.minute;
        }
      });
  }

  Future<void> _pickDate(bool isStart) async {
    final existing = parseDate(isStart ? startDate : endDate) ?? DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: existing.isBefore(DateTime(2000))
          ? DateTime(2000)
          : existing.isAfter(DateTime(2100))
          ? DateTime(2100)
          : existing,
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
    );
    if (picked != null && mounted)
      setState(() {
        if (isStart) {
          startDate = dateKey(picked);
        } else {
          endDate = dateKey(picked);
        }
      });
  }

  void _submit() {
    if (!form.currentState!.validate()) return;
    final c = Course(
      id:
          widget.course?.id ??
          'course-${DateTime.now().microsecondsSinceEpoch}',
      title: title.text.trim(),
      weekday: weekday,
      startMinutes: start,
      endMinutes: end,
      location: location.text.trim(),
      mapUrl: link.text.trim(),
      notes: notes.text.trim(),
      color: color,
      startDate: startDate,
      endDate: endDate,
    );
    if (c.validationError != null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(c.validationError!)));
      return;
    }
    Navigator.pop(context, c);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.course == null ? '添加课程' : '编辑课程'),
      actions: [TextButton(onPressed: _submit, child: const Text('保存'))],
    ),
    body: Form(
      key: form,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 40),
        children: [
          const Text('留一点秩序给每一天。', style: TextStyle(color: Color(0xff7b847b))),
          const SizedBox(height: 24),
          TextFormField(
            controller: title,
            maxLength: 120,
            decoration: const InputDecoration(
              labelText: '课程名称',
              hintText: '例如：线性代数',
            ),
            validator: (v) => v == null || v.trim().isEmpty ? '请输入课程名称' : null,
          ),
          const SizedBox(height: 16),
          const Text('每周重复', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: List.generate(
              7,
              (i) => ChoiceChip(
                label: Text('周${dayLabels[i]}'),
                selected: weekday == i + 1,
                onSelected: (_) => setState(() => weekday = i + 1),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Expanded(
                child: _picker(
                  '开始时间',
                  minuteLabel(start),
                  () => _pickTime(true),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _picker(
                  '结束时间',
                  minuteLabel(end),
                  () => _pickTime(false),
                ),
              ),
            ],
          ),
          const SizedBox(height: 22),
          TextFormField(
            controller: location,
            maxLength: 500,
            decoration: const InputDecoration(
              labelText: '上课地点 / 教室',
              hintText: '例如：某大学教学楼 A · 302',
              prefixIcon: Icon(Icons.place_outlined),
            ),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: link,
            keyboardType: TextInputType.url,
            maxLength: 4000,
            minLines: 1,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: '地图地址 / 自定义链接（可选）',
              hintText: 'https://…',
              helperText: '有链接时优先打开链接；否则用地点搜索 Google Maps',
              helperMaxLines: 2,
            ),
            validator: (v) => isSafeLink(v ?? '') ? null : '请输入有效网页或地图链接',
          ),
          Wrap(
            spacing: 8,
            children: [
              TextButton.icon(
                onPressed: () {
                  if (location.text.trim().isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('先填写上课地点，再生成地图链接')),
                    );
                    return;
                  }
                  setState(() => link.text = googleMapsLink(location.text));
                },
                icon: const Icon(Icons.map_outlined, size: 16),
                label: const Text('Google Maps'),
              ),
              TextButton.icon(
                onPressed: () {
                  if (location.text.trim().isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('先填写上课地点，再生成地图链接')),
                    );
                    return;
                  }
                  setState(() => link.text = amapLink(location.text));
                },
                icon: const Icon(Icons.near_me_outlined, size: 16),
                label: const Text('高德地图'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: notes,
            minLines: 2,
            maxLines: 5,
            maxLength: 4000,
            decoration: const InputDecoration(
              labelText: '备注（可选）',
              hintText: '老师、需要带的东西，或给自己的提醒',
            ),
          ),
          const SizedBox(height: 16),
          const Text('课程颜色', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          Row(
            children: courseColors
                .map(
                  (value) => Padding(
                    padding: const EdgeInsets.only(right: 12),
                    child: Semantics(
                      label: '课程颜色 ${courseColors.indexOf(value) + 1}',
                      selected: color == value,
                      child: InkWell(
                        onTap: () => setState(() => color = value),
                        borderRadius: BorderRadius.circular(30),
                        child: Container(
                          width: 42,
                          height: 42,
                          decoration: BoxDecoration(
                            color: Color(value),
                            shape: BoxShape.circle,
                          ),
                          child: color == value
                              ? const Icon(
                                  Icons.check,
                                  color: Colors.white,
                                  size: 21,
                                )
                              : null,
                        ),
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 24),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text(
              '学期日期范围（可选）',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            subtitle: const Text('未设置时，每周持续重复', style: TextStyle(fontSize: 11)),
            children: [
              Row(
                children: [
                  Expanded(
                    child: _picker(
                      '开始日期',
                      startDate ?? '不限',
                      () => _pickDate(true),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _picker(
                      '结束日期',
                      endDate ?? '不限',
                      () => _pickDate(false),
                    ),
                  ),
                ],
              ),
              TextButton(
                onPressed: () => setState(() {
                  startDate = null;
                  endDate = null;
                }),
                child: const Text('清除日期范围'),
              ),
            ],
          ),
          if (widget.onDelete != null)
            TextButton(
              onPressed: () async {
                final deleted = await widget.onDelete!();
                if (deleted && context.mounted) Navigator.pop(context);
              },
              child: const Text('删除这门课程', style: TextStyle(color: Colors.red)),
            ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _submit,
            style: FilledButton.styleFrom(
              backgroundColor: ink,
              minimumSize: const Size(double.infinity, 52),
            ),
            child: const Text('保存课程'),
          ),
        ],
      ),
    ),
  );
  Widget _picker(String label, String value, VoidCallback onTap) =>
      OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 16),
          side: const BorderSide(color: Color(0xffdedfd8)),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        child: Column(
          children: [
            Text(
              label,
              style: const TextStyle(color: Color(0xff7b847b), fontSize: 11),
            ),
            const SizedBox(height: 5),
            Text(
              value,
              style: const TextStyle(
                color: ink,
                fontSize: 17,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      );
}
