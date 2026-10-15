import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'app_theme.dart';
import 'timetable.dart';

/// A detail-first surface: inspecting a class never opens a third-party service.
class CourseDetails extends StatelessWidget {
  const CourseDetails({
    super.key,
    required this.course,
    required this.onLongPress,
    required this.onEdit,
  });
  final Course course;
  final VoidCallback onLongPress, onEdit;
  @override
  Widget build(BuildContext context) {
    final c = course;
    return Semantics(
      customSemanticsActions: {
        CustomSemanticsAction(label: '导航到上课地点'): onLongPress,
      },
      child: GestureDetector(
        onLongPress: onLongPress,
        behavior: HitTestBehavior.opaque,
        child: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 34),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: Color(c.color),
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '每周${dayLabels[c.weekday - 1]}',
                      style: const TextStyle(
                        color: teal,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const Spacer(),
                    TextButton.icon(
                      onPressed: onEdit,
                      icon: const Icon(Icons.edit_outlined, size: 16),
                      label: const Text('编辑'),
                    ),
                    IconButton(
                      tooltip: '关闭详情',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Text(
                  c.title,
                  style: const TextStyle(
                    fontSize: 30,
                    fontWeight: FontWeight.w800,
                    height: 1.3,
                  ),
                ),
                const SizedBox(height: 22),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(22),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        Colors.white,
                        Color(c.color).withValues(alpha: .09),
                      ],
                    ),
                    border: Border.all(color: Colors.white, width: 1.5),
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: [
                      BoxShadow(
                        color: ink.withValues(alpha: .05),
                        blurRadius: 28,
                        offset: const Offset(0, 8),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '上课时间',
                        style: TextStyle(
                          color: Color(0xff758078),
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        c.timeLabel,
                        style: const TextStyle(
                          fontSize: 29,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -.5,
                        ),
                      ),
                      const SizedBox(height: 24),
                      const Text(
                        '上课地点',
                        style: TextStyle(
                          color: Color(0xff758078),
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        c.location.isEmpty ? '尚未添加地点' : c.location,
                        style: const TextStyle(
                          fontSize: 21,
                          fontWeight: FontWeight.w600,
                          height: 1.5,
                        ),
                      ),
                    ],
                  ),
                ),
                if (c.startDate != null || c.endDate != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 18),
                    child: Text(
                      '日期范围：${c.startDate ?? '不限'} 至 ${c.endDate ?? '不限'}',
                      style: const TextStyle(
                        color: Color(0xff758078),
                        fontSize: 12,
                      ),
                    ),
                  ),
                if (c.notes.isNotEmpty) ...[
                  const SizedBox(height: 26),
                  const Text(
                    '课程备注',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    c.notes,
                    style: const TextStyle(fontSize: 16, height: 1.8),
                  ),
                ],
                const SizedBox(height: 28),
                const Text(
                  '长按课程信息，可选择导航等操作',
                  style: TextStyle(
                    fontSize: 11,
                    color: Color(0xff8b918a),
                    height: 1.6,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Context actions are isolated from the readable course surface.
/// Add future actions here without changing card layouts or domain data.
class CourseActionMenu extends StatelessWidget {
  const CourseActionMenu({super.key, required this.onNavigate});
  final VoidCallback onNavigate;
  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      child: ListTile(
        leading: const Icon(Icons.near_me_outlined, color: teal),
        title: const Text('导航到上课地点'),
        onTap: onNavigate,
      ),
    ),
  );
}

class NavigationChoices extends StatelessWidget {
  const NavigationChoices({
    super.key,
    required this.course,
    required this.onOpen,
  });
  final Course course;
  final Future<void> Function(String) onOpen;
  @override
  Widget build(BuildContext context) => SafeArea(
    child: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 4, 24, 26),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '用哪个方式导航？',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 18),
          if (course.location.isNotEmpty) ...[
            _choice(
              'Google Maps',
              Icons.map_outlined,
              googleMapsLink(course.location),
            ),
            _choice('高德地图', Icons.near_me_outlined, amapLink(course.location)),
          ],
          if (course.mapUrl.isNotEmpty)
            _choice('已保存的自定义链接', Icons.open_in_new, course.mapUrl),
          if (course.destination.isEmpty)
            const Text('还没有地点或链接，请在课程详情中编辑添加。', style: TextStyle(height: 1.6)),
          const SizedBox(height: 16),
          const Text(
            '目的地将交给所选地图或网页服务。请核对完整校园与建筑；教室编号可能无法准确定位。',
            style: TextStyle(
              fontSize: 11,
              color: Color(0xff8b918a),
              height: 1.6,
            ),
          ),
        ],
      ),
    ),
  );
  Widget _choice(String title, IconData icon, String url) => ListTile(
    leading: Icon(icon, color: teal),
    title: Text(title),
    trailing: const Icon(Icons.arrow_outward, size: 18),
    onTap: () => onOpen(url),
  );
}
