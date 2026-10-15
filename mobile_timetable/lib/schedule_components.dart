import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'app_theme.dart';
import 'timetable.dart';

class CourseCard extends StatelessWidget {
  const CourseCard({
    super.key,
    required this.course,
    required this.active,
    required this.onTap,
    required this.onLongPress,
  });
  final Course course;
  final bool active;
  final VoidCallback onTap, onLongPress;
  @override
  Widget build(BuildContext context) {
    final c = course;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 55,
            child: Padding(
              padding: const EdgeInsets.only(top: 19),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    minuteLabel(c.startMinutes),
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    minuteLabel(c.endMinutes),
                    style: const TextStyle(
                      color: Color(0xff8b9087),
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ),
          ),
          Expanded(
            child: Semantics(
              customSemanticsActions: {
                CustomSemanticsAction(label: '导航到上课地点'): onLongPress,
              },
              child: Material(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                child: InkWell(
                  key: ValueKey('course-card-${c.id}'),
                  borderRadius: BorderRadius.circular(20),
                  onTap: onTap,
                  onLongPress: onLongPress,
                  child: Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      border: Border.all(
                        color: active
                            ? Color(c.color)
                            : const Color(0xffe7e5de),
                        width: active ? 1.5 : 1,
                      ),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Container(
                              width: 4,
                              height: 20,
                              decoration: BoxDecoration(
                                color: Color(c.color),
                                borderRadius: BorderRadius.circular(4),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                c.title,
                                style: const TextStyle(
                                  fontSize: 17,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                          ],
                        ),
                        if (c.location.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 10),
                            child: Text(
                              c.location,
                              style: const TextStyle(
                                color: Color(0xff64736a),
                                fontSize: 13,
                                height: 1.5,
                              ),
                            ),
                          ),
                        if (c.notes.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              c.notes,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: Color(0xff8c918a),
                                fontSize: 11,
                                height: 1.5,
                              ),
                            ),
                          ),
                        if (active)
                          Padding(
                            padding: const EdgeInsets.only(top: 10),
                            child: Text(
                              '正在上课',
                              style: TextStyle(
                                color: Color(c.color),
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class CurrentCourseCard extends StatelessWidget {
  const CurrentCourseCard({
    super.key,
    required this.course,
    required this.current,
    required this.simultaneous,
    required this.onTap,
    required this.onLongPress,
  });
  final Course? course;
  final bool current;
  final int simultaneous;
  final VoidCallback? onTap, onLongPress;
  @override
  Widget build(BuildContext context) => Material(
    color: ink,
    borderRadius: BorderRadius.circular(26),
    child: InkWell(
      borderRadius: BorderRadius.circular(26),
      onTap: onTap,
      onLongPress: onLongPress,
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 7,
                  height: 7,
                  decoration: const BoxDecoration(
                    color: Color(0xffe2b879),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    current
                        ? '正在上课${simultaneous > 1 ? ' · 同时有 $simultaneous 门课' : ''}'
                        : course != null
                        ? '下一节 · 今天'
                        : '此刻，留给自己',
                    style: const TextStyle(
                      color: Color(0xffe2b879),
                      fontSize: 12,
                      letterSpacing: 1,
                    ),
                  ),
                ),
                const Icon(
                  Icons.wb_sunny_outlined,
                  color: Color(0xffe2b879),
                  size: 20,
                ),
              ],
            ),
            const SizedBox(height: 20),
            Text(
              course?.title ?? '今天余下时间没有课',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 25,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              course?.timeLabel ?? '给思考、散步和休息留一点空间。',
              style: const TextStyle(color: Colors.white70, fontSize: 16),
            ),
            if (course != null) ...[
              const SizedBox(height: 19),
              Row(
                children: [
                  const Icon(
                    Icons.place_outlined,
                    size: 16,
                    color: Colors.white60,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      course!.location.isEmpty ? '尚未添加地点' : course!.location,
                      style: const TextStyle(
                        color: Colors.white70,
                        fontSize: 13,
                        height: 1.5,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    ),
  );
}
